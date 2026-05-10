cmake_minimum_required(VERSION 3.20)
project(omni_search VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# MSVC requires /utf-8 for Unicode source and spdlog/fmt
if(MSVC)
    add_compile_options(/utf-8)
endif()

# =============================================================================
# OPTIONS
# =============================================================================

option(OMNI_SEARCH_USE_OMNI_REPO "Link against omni-repo libraries" OFF)
option(OMNI_SEARCH_USE_TENSORRT "Use TensorRT for inference acceleration" ON)
option(OMNI_SEARCH_BUILD_TESTS "Build unit tests" OFF)

# =============================================================================
# DEPENDENCIES
# =============================================================================

# Required: SQLite3
find_package(SQLite3 REQUIRED)

# Required: OpenCV
find_package(OpenCV REQUIRED)

# Required: spdlog
find_package(spdlog REQUIRED)

# Required: nlohmann_json
find_package(nlohmann_json REQUIRED)

# ONNX Runtime (required for inference)
set(ONNXRUNTIME_FOUND FALSE)
if(DEFINED ENV{ONNXRUNTIME_ROOT})
    set(ONNXRUNTIME_ROOT_DIR $ENV{ONNXRUNTIME_ROOT})
else()
    # Auto-detect from known install locations
    foreach(_ort_candidate
        "C:/dev/onnxruntime/onnxruntime-win-x64-gpu-1.26.0"
        "C:/dev/onnxruntime"
        "C:/onnxruntime")
        if(EXISTS "${_ort_candidate}/include/onnxruntime_cxx_api.h")
            set(ONNXRUNTIME_ROOT_DIR "${_ort_candidate}")
            break()
        endif()
    endforeach()
endif()

if(DEFINED ONNXRUNTIME_ROOT_DIR)
    find_path(ONNXRUNTIME_INCLUDE_DIR
        NAMES onnxruntime_cxx_api.h
        PATHS "${ONNXRUNTIME_ROOT_DIR}/include"
        NO_DEFAULT_PATH)
    find_library(ONNXRUNTIME_LIBRARY
        NAMES onnxruntime
        PATHS "${ONNXRUNTIME_ROOT_DIR}/lib"
        NO_DEFAULT_PATH)
    if(ONNXRUNTIME_INCLUDE_DIR AND ONNXRUNTIME_LIBRARY)
        set(ONNXRUNTIME_FOUND TRUE)
        set(ONNXRUNTIME_BIN_DIR "${ONNXRUNTIME_ROOT_DIR}/lib")
        message(STATUS "Found ONNX Runtime: ${ONNXRUNTIME_LIBRARY}")
        message(STATUS "ONNX Runtime include: ${ONNXRUNTIME_INCLUDE_DIR}")
    endif()
endif()

if(NOT ONNXRUNTIME_FOUND)
    message(WARNING "ONNX Runtime not found. Set ONNXRUNTIME_ROOT environment variable.")
endif()

# TensorRT (optional for GPU acceleration)
set(TENSORRT_FOUND FALSE)
if(OMNI_SEARCH_USE_TENSORRT)
    # Check env var first, then well-known local paths
    if(DEFINED ENV{TENSORRT_ROOT})
        set(TENSORRT_ROOT_DIR $ENV{TENSORRT_ROOT})
    else()
        # Auto-detect from known install locations
        foreach(_trt_candidate
            "C:/dev/TensorRT-sdk/TensorRT-10.16.1.11"
            "C:/TensorRT"
            "C:/dev/TensorRT")
            if(EXISTS "${_trt_candidate}/lib/nvinfer_10.lib" OR
               EXISTS "${_trt_candidate}/lib/nvinfer.lib")
                set(TENSORRT_ROOT_DIR "${_trt_candidate}")
                break()
            endif()
        endforeach()
    endif()

    if(DEFINED TENSORRT_ROOT_DIR)
        find_path(TENSORRT_INCLUDE_DIR
            NAMES NvInfer.h
            PATHS "${TENSORRT_ROOT_DIR}/include"
            NO_DEFAULT_PATH)
        # TensorRT 10.x uses versioned lib name nvinfer_10.lib
        find_library(TENSORRT_LIBRARY
            NAMES nvinfer_10 nvinfer
            PATHS "${TENSORRT_ROOT_DIR}/lib"
            NO_DEFAULT_PATH)
        find_library(TENSORRT_ONNXPARSER_LIBRARY
            NAMES nvonnxparser_10 nvonnxparser
            PATHS "${TENSORRT_ROOT_DIR}/lib"
            NO_DEFAULT_PATH)
        if(TENSORRT_INCLUDE_DIR AND TENSORRT_LIBRARY)
            set(TENSORRT_FOUND TRUE)
            set(TENSORRT_BIN_DIR "${TENSORRT_ROOT_DIR}/bin")
            message(STATUS "Found TensorRT 10: ${TENSORRT_LIBRARY}")
            message(STATUS "TensorRT include: ${TENSORRT_INCLUDE_DIR}")
            message(STATUS "TensorRT bin: ${TENSORRT_BIN_DIR}")
        endif()
    endif()

    if(NOT TENSORRT_FOUND)
        message(WARNING "TensorRT not found. Will use ONNX Runtime fallback only.")
    endif()
endif()

# omni-repo libraries (optional)
if(OMNI_SEARCH_USE_OMNI_REPO)
    if(DEFINED ENV{OMNI_REPO_ROOT})
        set(OMNI_REPO_ROOT $ENV{OMNI_REPO_ROOT})
    elseif(NOT DEFINED OMNI_REPO_ROOT)
        set(OMNI_REPO_ROOT "${CMAKE_SOURCE_DIR}/../omni-repo")
    endif()
    
    if(EXISTS "${OMNI_REPO_ROOT}")
        include_directories(
            "${OMNI_REPO_ROOT}/omni_ai_ml/include"
            "${OMNI_REPO_ROOT}/omni_video_editing/include"
            "${OMNI_REPO_ROOT}/omni_audio_production/include"
            "${OMNI_REPO_ROOT}/omni_image_processing/include"
        )
        message(STATUS "Using omni-repo from: ${OMNI_REPO_ROOT}")
        add_compile_definitions(OMNI_SEARCH_USE_OMNI_REPO)
    else()
        message(WARNING "OMNI_REPO_ROOT not found: ${OMNI_REPO_ROOT}")
        set(OMNI_SEARCH_USE_OMNI_REPO OFF)
    endif()
endif()

# =============================================================================
# SOURCES
# =============================================================================

set(SOURCES
    src/main.cpp
    src/config/config.cpp
    src/db/storage.cpp
    src/engine/embedding_engine.cpp
    src/engine/bpe_tokenizer.cpp
    src/indexer/indexer.cpp
    src/search/search_engine.cpp
    src/chat/chatbot.cpp
)

# Add stubs if not using omni-repo
if(NOT OMNI_SEARCH_USE_OMNI_REPO)
    list(APPEND SOURCES src/stubs/omni_stubs.cpp)
endif()

# =============================================================================
# EXECUTABLE
# =============================================================================

add_executable(omni_search ${SOURCES})

# =============================================================================
# INCLUDE DIRECTORIES
# =============================================================================

target_include_directories(omni_search PRIVATE
    ${CMAKE_SOURCE_DIR}/include
    ${SQLite3_INCLUDE_DIRS}
    ${OpenCV_INCLUDE_DIRS}
)

if(ONNXRUNTIME_FOUND)
    target_include_directories(omni_search PRIVATE ${ONNXRUNTIME_INCLUDE_DIR})
endif()

if(TENSORRT_FOUND)
    target_include_directories(omni_search PRIVATE ${TENSORRT_INCLUDE_DIR})
    add_compile_definitions(OMNI_SEARCH_USE_TRT)
    # TensorRT headers require CUDA runtime headers
    find_path(CUDA_INCLUDE_DIR cuda_runtime_api.h
        PATHS
            "$ENV{CUDA_PATH}/include"
            "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v11.8/include"
            "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.0/include"
            "C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.4/include"
        NO_DEFAULT_PATH)
    if(CUDA_INCLUDE_DIR)
        target_include_directories(omni_search PRIVATE ${CUDA_INCLUDE_DIR})
        message(STATUS "CUDA include: ${CUDA_INCLUDE_DIR}")
    endif()
endif()

# =============================================================================
# LINKING
# =============================================================================

target_link_libraries(omni_search PRIVATE
    SQLite::SQLite3
    ${OpenCV_LIBS}
    spdlog::spdlog
    nlohmann_json::nlohmann_json
)

if(ONNXRUNTIME_FOUND)
    target_link_libraries(omni_search PRIVATE ${ONNXRUNTIME_LIBRARY})
    # Copy ONNX Runtime DLLs next to executable on Windows
    if(WIN32 AND ONNXRUNTIME_BIN_DIR)
        add_custom_command(TARGET omni_search POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${ONNXRUNTIME_BIN_DIR}"
                $<TARGET_FILE_DIR:omni_search>
            COMMENT "Copying ONNX Runtime DLLs to output directory"
        )
    endif()
endif()

if(TENSORRT_FOUND)
    target_link_libraries(omni_search PRIVATE ${TENSORRT_LIBRARY})
    if(TENSORRT_ONNXPARSER_LIBRARY)
        target_link_libraries(omni_search PRIVATE ${TENSORRT_ONNXPARSER_LIBRARY})
    endif()
    # Link CUDA runtime for cudaMalloc/cudaFree/cudaMemcpy
    if(CUDA_INCLUDE_DIR)
        get_filename_component(CUDA_ROOT "${CUDA_INCLUDE_DIR}" DIRECTORY)
        find_library(CUDA_RUNTIME_LIB cudart
            PATHS "${CUDA_ROOT}/lib/x64" "${CUDA_ROOT}/lib64" "${CUDA_ROOT}/lib"
            NO_DEFAULT_PATH)
        if(CUDA_RUNTIME_LIB)
            target_link_libraries(omni_search PRIVATE ${CUDA_RUNTIME_LIB})
            message(STATUS "CUDA runtime: ${CUDA_RUNTIME_LIB}")
        endif()
    endif()
    # On Windows, copy TensorRT DLLs next to the executable so it can find them
    if(WIN32 AND TENSORRT_BIN_DIR)
        add_custom_command(TARGET omni_search POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_directory
                "${TENSORRT_BIN_DIR}"
                $<TARGET_FILE_DIR:omni_search>
            COMMENT "Copying TensorRT DLLs to output directory"
        )
    endif()
endif()

# Link against omni-repo libraries if enabled
if(OMNI_SEARCH_USE_OMNI_REPO)
    find_library(OMNI_AI_ML_LIB omni_ai_ml PATHS "${OMNI_REPO_ROOT}/build/lib" NO_DEFAULT_PATH)
    find_library(OMNI_VIDEO_LIB omni_video_editing PATHS "${OMNI_REPO_ROOT}/build/lib" NO_DEFAULT_PATH)
    
    if(OMNI_AI_ML_LIB)
        target_link_libraries(omni_search PRIVATE ${OMNI_AI_ML_LIB})
    endif()
    if(OMNI_VIDEO_LIB)
        target_link_libraries(omni_search PRIVATE ${OMNI_VIDEO_LIB})
    endif()
endif()

# Platform-specific linking
if(WIN32)
    target_link_libraries(omni_search PRIVATE ws2_32)
endif()

# =============================================================================
# OUTPUT
# =============================================================================

if(WIN32)
    set_target_properties(omni_search PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY_RELEASE ${CMAKE_BINARY_DIR}/Release
        RUNTIME_OUTPUT_DIRECTORY_DEBUG ${CMAKE_BINARY_DIR}/Debug
    )
else()
    set_target_properties(omni_search PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}
    )
endif()

# =============================================================================
# INSTALL
# =============================================================================

install(TARGETS omni_search
    RUNTIME DESTINATION bin
)

# =============================================================================
# STATUS
# =============================================================================

message(STATUS "=== Omni-Search Build Configuration ===")
message(STATUS "  CMake version: ${CMAKE_VERSION}")
message(STATUS "  C++ standard: ${CMAKE_CXX_STANDARD}")
message(STATUS "  Build type: ${CMAKE_BUILD_TYPE}")
message(STATUS "  OpenCV version: ${OpenCV_VERSION}")
message(STATUS "  SQLite3: ${SQLite3_VERSION}")
message(STATUS "  ONNX Runtime: ${ONNXRUNTIME_FOUND}")
message(STATUS "  TensorRT: ${TENSORRT_FOUND}")
message(STATUS "  omni-repo: ${OMNI_SEARCH_USE_OMNI_REPO}")
message(STATUS "========================================")
