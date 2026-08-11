#pragma once
/**
 * SlotManager — thread-safe call-slot gatekeeper for 15-concurrent-call limit.
 *
 * Tracks active Telnyx WebSocket sessions by call_session_id. Uses a mutex-guarded
 * unordered_set for O(1) acquisition / release, plus an atomic active count for
 * cheap lock-free reads (e.g., /capacity endpoint).
 *
 * Design notes:
 *  - acquire() is idempotent: re-acquiring an already-held session_id returns true.
 *  - release() is safe to call even if the id was never acquired (no-op).
 *  - HIGH_WATERMARK_RATIO fires a user-supplied callback once when load crosses
 *    80 %, giving the Cloudflare Durable Object edge router time to warm a new
 *    container before the hard cap is hit.
 */

#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <unordered_set>

namespace patter {

class SlotManager {
public:
    /**
     * @param max_slots   Hard cap on concurrent sessions. Default: MAX_CONTAINER_CALL_SLOTS
     *                    env var parsed at construction, or 15 if unset.
     * @param on_hwm      Callback fired once when active slots cross the high-watermark
     *                    threshold (default 80 %). Use it to trigger pre-warming a new
     *                    container instance via the Durable Object capacity API.
     */
    explicit SlotManager(
        int max_slots = 0,
        std::function<void(int active, int max)> on_hwm = nullptr
    );

    /**
     * Attempt to acquire a call slot for the given session ID.
     *
     * @return true  — slot acquired (or already held by this session_id).
     * @return false — container is at capacity; caller should close the WebSocket
     *                 with code 1013 ("Try Again Later") and let Telnyx re-route.
     */
    bool acquire(const std::string& session_id);

    /**
     * Release the slot held by session_id. Safe to call if id was never acquired.
     */
    void release(const std::string& session_id);

    /** Current number of active sessions. Lock-free atomic read. */
    int active_count() const noexcept { return active_.load(std::memory_order_relaxed); }

    /** True if the container is at or above max_slots_. */
    bool at_capacity()  const noexcept { return active_.load(std::memory_order_relaxed) >= max_slots_; }

    /** Number of open slots remaining. */
    int available_slots() const noexcept {
        return std::max(0, max_slots_ - active_.load(std::memory_order_relaxed));
    }

    int max_slots() const noexcept { return max_slots_; }

private:
    const int max_slots_;
    const double hwm_ratio_ = 0.80;
    std::function<void(int, int)> on_hwm_;
    bool hwm_fired_ = false;

    mutable std::mutex mu_;
    std::unordered_set<std::string> sessions_;  // protected by mu_
    std::atomic<int> active_{0};                // mirrored from sessions_.size()

    void check_watermark(int active);
};

}  // namespace patter
