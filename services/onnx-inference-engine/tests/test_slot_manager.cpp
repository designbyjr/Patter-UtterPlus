/**
 * test_slot_manager.cpp — Google Test suite for patter::SlotManager.
 *
 * Tests cover:
 *   1. Default construction (env var fallback)
 *   2. Basic acquire / release
 *   3. Idempotent re-acquire
 *   4. Hard capacity limit
 *   5. acquire returns false at capacity
 *   6. release of unknown ID is no-op
 *   7. Atomic active_count / available_slots / at_capacity
 *   8. High-watermark callback fires exactly once per surge
 *   9. High-watermark latch resets after load drops
 *  10. Thread-safety: 32 threads acquiring / releasing concurrently
 */

#include <gtest/gtest.h>
#include <atomic>
#include <string>
#include <thread>
#include <vector>

#include "slot_manager.h"

using patter::SlotManager;

// ── 1. Default construction ────────────────────────────────────────────────────

TEST(SlotManagerTest, DefaultMaxSlotsFallback) {
    // Without env var, defaults to 4 (standard-4 instance sizing)
    unsetenv("MAX_CONTAINER_CALL_SLOTS");
    SlotManager mgr;
    EXPECT_EQ(mgr.max_slots(), 4);
}

TEST(SlotManagerTest, EnvVarOverridesDefault) {
    setenv("MAX_CONTAINER_CALL_SLOTS", "7", 1);
    SlotManager mgr; // reads env at construction
    EXPECT_EQ(mgr.max_slots(), 7);
    unsetenv("MAX_CONTAINER_CALL_SLOTS");
}

TEST(SlotManagerTest, ExplicitMaxSlotsIgnoresEnvVar) {
    setenv("MAX_CONTAINER_CALL_SLOTS", "99", 1);
    SlotManager mgr(5);
    EXPECT_EQ(mgr.max_slots(), 5);
    unsetenv("MAX_CONTAINER_CALL_SLOTS");
}

// ── 2. Initial state ───────────────────────────────────────────────────────────

TEST(SlotManagerTest, InitialState) {
    SlotManager mgr(10);
    EXPECT_EQ(mgr.active_count(),   0);
    EXPECT_EQ(mgr.available_slots(), 10);
    EXPECT_FALSE(mgr.at_capacity());
}

// ── 3. Basic acquire ──────────────────────────────────────────────────────────

TEST(SlotManagerTest, AcquireReturnsTrueAndIncrementsCount) {
    SlotManager mgr(5);
    EXPECT_TRUE(mgr.acquire("sess-001"));
    EXPECT_EQ(mgr.active_count(), 1);
    EXPECT_EQ(mgr.available_slots(), 4);
    EXPECT_FALSE(mgr.at_capacity());
}

// ── 4. Idempotent re-acquire ──────────────────────────────────────────────────

TEST(SlotManagerTest, IdempotentReacquire) {
    SlotManager mgr(5);
    EXPECT_TRUE(mgr.acquire("sess-001"));
    EXPECT_TRUE(mgr.acquire("sess-001")); // re-acquire same ID
    EXPECT_EQ(mgr.active_count(), 1);     // still 1, not 2
}

// ── 5. Hard capacity limit ────────────────────────────────────────────────────

TEST(SlotManagerTest, AcquireReturnsFalseAtCapacity) {
    SlotManager mgr(3);
    EXPECT_TRUE(mgr.acquire("c1"));
    EXPECT_TRUE(mgr.acquire("c2"));
    EXPECT_TRUE(mgr.acquire("c3"));
    EXPECT_TRUE(mgr.at_capacity());

    // 4th acquire must be rejected
    EXPECT_FALSE(mgr.acquire("c4"));
    EXPECT_EQ(mgr.active_count(), 3); // unchanged
}

TEST(SlotManagerTest, AvailableSlotsIsZeroAtCapacity) {
    SlotManager mgr(2);
    mgr.acquire("c1");
    mgr.acquire("c2");
    EXPECT_EQ(mgr.available_slots(), 0);
}

// ── 6. Release ────────────────────────────────────────────────────────────────

TEST(SlotManagerTest, ReleaseDecrementsCount) {
    SlotManager mgr(5);
    mgr.acquire("c1");
    mgr.acquire("c2");
    mgr.release("c1");
    EXPECT_EQ(mgr.active_count(), 1);
    EXPECT_EQ(mgr.available_slots(), 4);
}

TEST(SlotManagerTest, ReleaseUnknownIdIsNoOp) {
    SlotManager mgr(5);
    EXPECT_NO_THROW(mgr.release("never-acquired"));
    EXPECT_EQ(mgr.active_count(), 0);
}

TEST(SlotManagerTest, AfterReleaseSlotCanBeReused) {
    SlotManager mgr(2);
    EXPECT_TRUE(mgr.acquire("c1"));
    EXPECT_TRUE(mgr.acquire("c2"));
    EXPECT_FALSE(mgr.acquire("c3")); // at cap

    mgr.release("c1");
    EXPECT_TRUE(mgr.acquire("c3")); // now there's room
    EXPECT_TRUE(mgr.at_capacity());
}

// ── 7. High-watermark callback ─────────────────────────────────────────────────

TEST(SlotManagerTest, HighWatermarkFiredOnce) {
    std::atomic<int> cb_calls{0};
    int last_active = 0, last_max = 0;

    SlotManager mgr(5, [&](int a, int m) {
        cb_calls++;
        last_active = a;
        last_max    = m;
    });

    // 4/5 = 80 % — fires
    mgr.acquire("c1");
    mgr.acquire("c2");
    mgr.acquire("c3");
    mgr.acquire("c4");
    EXPECT_EQ(cb_calls.load(), 1);
    EXPECT_EQ(last_active, 4);
    EXPECT_EQ(last_max,    5);

    // 5/5 — should NOT re-fire (latch is set)
    mgr.acquire("c5");
    EXPECT_EQ(cb_calls.load(), 1);
}

TEST(SlotManagerTest, HighWatermarkResetsAfterLoadDrops) {
    std::atomic<int> cb_calls{0};
    SlotManager mgr(5, [&](int, int) { cb_calls++; });

    // First surge: 4/5 → fires
    mgr.acquire("c1"); mgr.acquire("c2");
    mgr.acquire("c3"); mgr.acquire("c4");
    EXPECT_EQ(cb_calls.load(), 1);

    // Drop below threshold (2/5 = 40 %)
    mgr.release("c4"); mgr.release("c3");

    // Second surge: 4/5 → fires again
    mgr.acquire("c5"); mgr.acquire("c6");
    mgr.acquire("c7"); mgr.acquire("c8");
    EXPECT_EQ(cb_calls.load(), 2);
}

TEST(SlotManagerTest, NoHighWatermarkCallbackWhenBelowThreshold) {
    bool fired = false;
    SlotManager mgr(10, [&](int, int) { fired = true; });

    // Fill to 70 % — below 80 %
    for (int i = 0; i < 7; i++) mgr.acquire("c" + std::to_string(i));
    EXPECT_FALSE(fired);
}

// ── 8. Thread safety ──────────────────────────────────────────────────────────

TEST(SlotManagerTest, ConcurrentAcquireReleaseIsThreadSafe) {
    constexpr int THREADS   = 32;
    constexpr int OPS_EACH  = 500;
    constexpr int MAX_SLOTS = 15;

    SlotManager mgr(MAX_SLOTS);

    std::vector<std::thread> threads;
    threads.reserve(THREADS);
    std::atomic<int> total_acquired{0};

    for (int t = 0; t < THREADS; ++t) {
        threads.emplace_back([&, t] {
            for (int i = 0; i < OPS_EACH; ++i) {
                std::string id = "t" + std::to_string(t) + "_" + std::to_string(i);
                if (mgr.acquire(id)) {
                    total_acquired.fetch_add(1, std::memory_order_relaxed);
                    // Brief critical section holding the slot
                    std::this_thread::yield();
                    mgr.release(id);
                }
            }
        });
    }
    for (auto& th : threads) th.join();

    // After all threads complete, the manager should be empty
    EXPECT_EQ(mgr.active_count(), 0);
    EXPECT_GE(mgr.available_slots(), 0);
    EXPECT_LE(mgr.active_count(), MAX_SLOTS);

    // At least some threads should have been able to acquire
    EXPECT_GT(total_acquired.load(), 0);
}

TEST(SlotManagerTest, ActiveCountNeverExceedsMaxDuringConcurrentLoad) {
    constexpr int THREADS   = 20;
    constexpr int MAX_SLOTS = 5;
    SlotManager   mgr(MAX_SLOTS);

    std::atomic<bool>  violation{false};
    std::vector<std::thread> threads;
    threads.reserve(THREADS);

    for (int t = 0; t < THREADS; ++t) {
        threads.emplace_back([&, t] {
            std::string id = "t" + std::to_string(t);
            if (mgr.acquire(id)) {
                if (mgr.active_count() > MAX_SLOTS) violation.store(true);
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                mgr.release(id);
            }
        });
    }
    for (auto& th : threads) th.join();
    EXPECT_FALSE(violation.load()) << "active_count exceeded max_slots under concurrency";
}
