load("//javascript/typescript:build_defs.bzl", "ts_library")

package(
    default_applicable_licenses = ["//third_party/hdrscope:license"],
    default_visibility = ["//third_party/hdrscope:__subpackages__"],
)

ts_library(
    name = "panels",
    srcs = [
        "agtm_renderer.ts",
        "base_renderer.ts",
        "canvas_sdr_renderer.ts",
        "curve_editor.ts",
        "hdr10p_renderer.ts",
        "hdr_renderer.ts",
        "luma_renderer.ts",
        "renderer.ts",
        "stats_viewer.ts",
    ],
    deps = [
        "//third_party/hdrscope/app:hdr_lib",
        "//third_party/hdrscope/app/color_helpers",
    ],
)
