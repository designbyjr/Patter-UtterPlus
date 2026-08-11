#include "crow.h"
#include "slot_manager.h"
#include "model_loader.h"
#include "inference_engine.h"
#include <iostream>
#include <cstdlib>
#include <memory>
#include <string>

using namespace patter;

int main(int argc, char** argv) {
    int port = 8080;
    if (const char* env_port = std::getenv("CAPACITY_HTTP_PORT")) {
        port = std::atoi(env_port);
    }

    int max_slots = 4;
    if (const char* env_slots = std::getenv("MAX_CONTAINER_CALL_SLOTS")) {
        max_slots = std::atoi(env_slots);
    }

    std::string container_id = "cpp-container-001";
    if (const char* env_id = std::getenv("CONTAINER_ID")) {
        container_id = env_id;
    }

    std::cout << "[PATTER C++] Starting native ONNX inference engine (max_slots=" << max_slots << ", port=" << port << ")" << std::endl;

    SlotManager slot_manager(max_slots, 0.80f, container_id, [](std::size_t active, std::size_t max_s) {
        std::cout << "[PATTER C++] High-watermark reached (" << active << "/" << max_s << ") — signalling pre-warm" << std::endl;
    });

    crow::SimpleApp app;

    CROW_ROUTE(app, "/capacity")
    .methods(crow::HTTPMethod::GET)([&slot_manager]() {
        auto stats = slot_manager.get_capacity_stats();
        crow::json::wvalue res;
        res["container_id"] = stats.container_id;
        res["status"] = stats.status;
        res["active_calls"] = stats.active_calls;
        res["max_slots"] = stats.max_slots;
        res["available_slots"] = stats.available_slots;
        res["memory_rss_mb"] = stats.memory_rss_mb;
        res["cpu_utilization_pct"] = stats.cpu_utilization_pct;
        res["uptime_seconds"] = stats.uptime_seconds;
        return crow::response(200, res);
    });

    CROW_ROUTE(app, "/health")
    .methods(crow::HTTPMethod::GET)([&slot_manager]() {
        auto stats = slot_manager.get_capacity_stats();
        crow::json::wvalue res;
        res["status"] = stats.status;
        return crow::response(200, res);
    });

    CROW_ROUTE(app, "/media")
    .websocket(&app)
    .onopen([&slot_manager](crow::websocket::connection& conn) {
        std::string call_id = conn.get_remote_ip(); // placeholder for connection session ID
        if (!slot_manager.acquire(call_id)) {
            conn.close("Container at capacity");
        }
    })
    .onclose([&slot_manager](crow::websocket::connection& conn, const std::string& reason) {
        std::string call_id = conn.get_remote_ip();
        slot_manager.release(call_id);
    })
    .onmessage([](crow::websocket::connection& conn, const std::string& data, bool is_binary) {
        if (is_binary) {
            // High-performance PCM frame processing
        }
    });

    app.port(port).multithreaded().run();
    return 0;
}
