cmake_minimum_required(VERSION 3.20)
project(PatterOnnxInferenceEngine VERSION 1.0.0 LANGUAGES CXX)

# ── C++ standard ──────────────────────────────────────────────────────────────
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ── Build type defaults ────────────────────────────────────────────────────────
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# ── Compiler flags ─────────────────────────────────────────────────────────────
add_compile_options(
  -Wall -Wextra -Wpedantic
  -Wno-unused-parameter
  # Address + UB sanitiser in Debug; strip in Release for minimal binary
  $<$<CONFIG:Debug>:-fsanitize=address,undefined -fno-omit-frame-pointer>
  $<$<CONFIG:Release>:-O3 -DNDEBUG>
)
add_link_options(
  $<$<CONFIG:Debug>:-fsanitize=address,undefined>
)

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)

# ── Asio (header-only, required by Crow) ──────────────────────────────────────
FetchContent_Declare(
  asio
  GIT_REPOSITORY https://github.com/chriskohlhoff/asio.git
  GIT_TAG        asio-1-28-0
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(asio)
add_library(asio INTERFACE)
target_include_directories(asio INTERFACE ${asio_SOURCE_DIR}/asio/include)
target_compile_definitions(asio INTERFACE ASIO_STANDALONE)

# ── Crow (header-only WebSocket / HTTP framework) ─────────────────────────────
FetchContent_Declare(
  crow
  GIT_REPOSITORY https://github.com/CrowCpp/Crow.git
  GIT_TAG        v1.2.0
  GIT_SHALLOW    TRUE
)
set(CROW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CROW_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(crow)

# ── nlohmann/json (header-only) ───────────────────────────────────────────────
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG        v3.11.3
  GIT_SHALLOW    TRUE
)
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(nlohmann_json)

# ── zstd ──────────────────────────────────────────────────────────────────────
find_package(zstd QUIET)
if(NOT zstd_FOUND)
  FetchContent_Declare(
    zstd
    GIT_REPOSITORY https://github.com/facebook/zstd.git
    GIT_TAG        v1.5.5
    GIT_SHALLOW    TRUE
    SOURCE_SUBDIR  build/cmake
  )
  set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "" FORCE)
  set(ZSTD_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
  set(ZSTD_BUILD_SHARED   OFF CACHE BOOL "" FORCE)
  FetchContent_MakeAvailable(zstd)
endif()

# ── ONNX Runtime ──────────────────────────────────────────────────────────────
# Prebuilt binaries for linux-x64 (matches Docker target).
# Override ONNXRUNTIME_ROOT to point at a local install.
set(ONNXRUNTIME_VERSION "1.18.0")
if(DEFINED ENV{ONNXRUNTIME_ROOT})
  set(ONNXRUNTIME_ROOT "$ENV{ONNXRUNTIME_ROOT}")
else()
  set(ONNXRUNTIME_ROOT "${CMAKE_BINARY_DIR}/_deps/onnxruntime")
  include(cmake/DownloadOnnxRuntime.cmake)
endif()

find_library(ORT_LIB onnxruntime
  PATHS "${ONNXRUNTIME_ROOT}/lib"
  NO_DEFAULT_PATH
  REQUIRED
)
find_path(ORT_INCLUDE_DIR onnxruntime_cxx_api.h
  PATHS "${ONNXRUNTIME_ROOT}/include"
  NO_DEFAULT_PATH
  REQUIRED
)

# ── libcurl ───────────────────────────────────────────────────────────────────
find_package(CURL REQUIRED)

# ── OpenSSL ───────────────────────────────────────────────────────────────────
find_package(OpenSSL REQUIRED)

# ── Threads ───────────────────────────────────────────────────────────────────
find_package(Threads REQUIRED)

# ── Shared library of engine code (used by both main exe and tests) ───────────
add_library(patter_engine_lib STATIC
  src/slot_manager.cpp
  src/model_loader.cpp
  src/inference_engine.cpp
)
target_include_directories(patter_engine_lib PUBLIC
  include/
  "${ORT_INCLUDE_DIR}"
  "${CURL_INCLUDE_DIRS}"
)
target_link_libraries(patter_engine_lib PUBLIC
  nlohmann_json::nlohmann_json
  "${ORT_LIB}"
  zstd::libzstd_static
  CURL::libcurl
  OpenSSL::SSL
  OpenSSL::Crypto
  Threads::Threads
)
target_compile_features(patter_engine_lib PUBLIC cxx_std_20)
set_target_properties(patter_engine_lib PROPERTIES
  INSTALL_RPATH "${ONNXRUNTIME_ROOT}/lib"
  BUILD_WITH_INSTALL_RPATH TRUE
)

# ── Main executable ───────────────────────────────────────────────────────────
add_executable(patter-inference-engine src/main.cpp)
target_link_libraries(patter-inference-engine PRIVATE
  patter_engine_lib
  Crow::Crow
  asio
)

# ── Unit tests ────────────────────────────────────────────────────────────────
option(PATTER_BUILD_TESTS "Build C++ unit tests" ON)

if(PATTER_BUILD_TESTS)
  enable_testing()

  # Google Test via FetchContent
  FetchContent_Declare(
    googletest
    GIT_REPOSITORY https://github.com/google/googletest.git
    GIT_TAG        v1.14.0
    GIT_SHALLOW    TRUE
  )
  set(BUILD_GMOCK            ON  CACHE BOOL "" FORCE)
  set(INSTALL_GTEST          OFF CACHE BOOL "" FORCE)
  set(gtest_force_shared_crt ON  CACHE BOOL "" FORCE) # Windows compat
  FetchContent_MakeAvailable(googletest)

  # Test executable — links patter_engine_lib (no Crow dep needed for tests)
  add_executable(patter-inference-tests
    tests/test_slot_manager.cpp
    tests/test_model_loader.cpp
    tests/test_inference_engine.cpp
  )
  target_link_libraries(patter-inference-tests PRIVATE
    patter_engine_lib
    GTest::gtest_main
    GTest::gmock
  )
  target_include_directories(patter-inference-tests PRIVATE include/)

  include(GoogleTest)
  gtest_discover_tests(patter-inference-tests
    EXTRA_ARGS --gtest_color=yes
    DISCOVERY_TIMEOUT 60
  )

  # Convenience target: build + run tests
  add_custom_target(run-tests
    COMMAND patter-inference-tests --gtest_color=yes
    DEPENDS patter-inference-tests
    WORKING_DIRECTORY "${CMAKE_BINARY_DIR}"
    COMMENT "Running C++ unit tests..."
  )
endif()

# ── Install rules ─────────────────────────────────────────────────────────────
install(TARGETS patter-inference-engine RUNTIME DESTINATION bin)
install(FILES   "${ORT_LIB}"            DESTINATION lib)
