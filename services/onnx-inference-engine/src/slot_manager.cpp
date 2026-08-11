/**
 * slot_manager.cpp — thread-safe call-slot gatekeeper implementation.
 */

#include "slot_manager.h"

#include <algorithm>
#include <cstdlib>
#include <stdexcept>

namespace patter {

// ── Construction ──────────────────────────────────────────────────────────────

SlotManager::SlotManager(int max_slots, std::function<void(int, int)> on_hwm)
    : max_slots_([&] {
          if (max_slots > 0) return max_slots;
          const char* env = std::getenv("MAX_CONTAINER_CALL_SLOTS");
          if (env && *env) {
              int val = std::atoi(env);
              if (val > 0) return val;
          }
          return 15; // safe default for standard-3 (8 GB / 2 vCPU)
      }()),
      on_hwm_(std::move(on_hwm)) {}

// ── acquire ────────────────────────────────────────────────────────────────────

bool SlotManager::acquire(const std::string& session_id) {
    std::lock_guard<std::mutex> lock(mu_);

    // Idempotent re-acquire
    if (sessions_.count(session_id)) return true;

    // Hard cap check
    if (static_cast<int>(sessions_.size()) >= max_slots_) {
        return false;
    }

    sessions_.insert(session_id);
    int current = static_cast<int>(sessions_.size());
    active_.store(current, std::memory_order_relaxed);

    // High-watermark check (still within the lock — sessions_.size() is stable)
    check_watermark(current);

    return true;
}

// ── release ────────────────────────────────────────────────────────────────────

void SlotManager::release(const std::string& session_id) {
    std::lock_guard<std::mutex> lock(mu_);
    sessions_.erase(session_id); // no-op if absent
    int current = static_cast<int>(sessions_.size());
    active_.store(current, std::memory_order_relaxed);

    // Reset high-watermark latch once load drops below threshold
    if (static_cast<double>(current) / max_slots_ < hwm_ratio_) {
        hwm_fired_ = false;
    }
}

// ── check_watermark ────────────────────────────────────────────────────────────

void SlotManager::check_watermark(int active) {
    if (hwm_fired_) return;
    double ratio = static_cast<double>(active) / max_slots_;
    if (ratio >= hwm_ratio_) {
        hwm_fired_ = true;
        if (on_hwm_) {
            // Invoke callback outside the lock to avoid potential deadlock
            // We release the lock first by design (callback is invoked after
            // the critical section modifying sessions_).
            // NOTE: on_hwm_ is called while mu_ is held. Keep callbacks fast.
            on_hwm_(active, max_slots_);
        }
    }
}

}  // namespace patter
