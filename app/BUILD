load("//javascript/typescript:build_defs.bzl", "ts_library")
load("//testing/web/build_defs/js_test:js_test_suite.bzl", "js_test_suite")

package(
    default_applicable_licenses = ["//third_party/hdrscope:license"],
    default_visibility = [
        "//third_party/hdrscope:__pkg__",
        "//third_party/hdrscope:__subpackages__",
    ],
)

ts_library(
    name = "agtm_metadata_types",
    srcs = [
        "agtm_metadata_types.ts",
    ],
)

ts_library(
    name = "hdr_lib",
    srcs = [
        "agtm_generator.ts",
        "agtm_muxer.ts",
        "agtm_parser.ts",
        "bitstream.ts",
        "builtin_agtm.ts",
        "download.ts",
        "global_interfaces.ts",
        "icc.ts",
        "image_stats.ts",
        "isobmff.ts",
        "json.ts",
        "load_media.ts",
        "media_parser.ts",
        "webm.ts",
    ],
    deps = [
        ":agtm_metadata_types",
        "//third_party/hdrscope/app/color_helpers",
        "//third_party/hdrscope/google_internal:google_internal_lib",
        "//third_party/hdrscope/google_internal:wasm",
        "//third_party/javascript/jszip",
        "//third_party/javascript/node_modules/typescript:es2020.bigint",
        "//third_party/javascript/node_modules/typescript:esnext.float16",
        "//third_party/javascript/safevalues",
        "//third_party/javascript/safevalues/dom",
        "//third_party/javascript/upng:upng_raw",
    ],
)

ts_library(
    name = "test_files",
    srcs = [
        "test_files.ts",
    ],
)

ts_library(
    name = "hdrscope_app",
    srcs = [
        "app.ts",
    ],
    deps = [
        ":agtm_metadata_types",
        ":hdr_lib",
        ":test_files",
        "//third_party/hdrscope/app/color_helpers",
        "//third_party/hdrscope/app/panels",
        "//third_party/hdrscope/google_internal:google_internal_lib",
        "//third_party/hdrscope/google_internal/panels",
        "//third_party/javascript/jszip",
        "//third_party/javascript/safevalues/dom",
    ],
)

ts_library(
    name = "hdrscope_main",
    srcs = [
        "main.ts",
    ],
    deps = [
        ":hdr_lib",
        ":hdrscope_app",
        "//third_party/hdrscope/google_internal:wasm",
    ],
)

ts_library(
    name = "tests_srcs",
    testonly = True,
    srcs = [
        "agtm_muxer_test.ts",
        "media_parser_test.ts",
    ],
    deps = [
        ":hdr_lib",
        "//third_party/hdrscope/app/color_helpers",
        "//third_party/javascript/typings/jasmine",
    ],
)

# Debug with:
# iblaze run //third_party/hdrscope/app:js_tests_debug
js_test_suite(
    name = "js_tests",
    browsers = ["//testing/web/browsers:chrome-linux"],
    config_file = "//third_party/hdrscope/google_internal:karma.conf.js",
    data = ["//third_party/hdrscope:data_files"],
    test_lib = ":tests_srcs",
)
