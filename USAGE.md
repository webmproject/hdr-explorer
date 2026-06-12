# HDR Explorer User Guide

HDR Explorer is a web-based tool for visualizing and experimenting with High
Dynamic Range (HDR) images and videos, with a particular focus on the
[SMPTE ST 2094-50](https://github.com/SMPTE/st2094-50) standard.
It allows you to compare different rendering methods, adjust parameters, and
analyze metadata in real-time.

[LIVE DEMO](https://webmproject.github.io/hdr-explorer/)

## System & Browser Requirements

To get the best experience and properly visualize HDR content on an
HDR-capable display, HDR Explorer relies on modern web features. Specifically:

- **Chrome / Chromium:** Version 131 or higher is recommended.
- **Experimental Web Platform Features:** You must enable the "Experimental Web
  Platform Features" flag in Chrome by navigating to
  `chrome://flags/#enable-experimental-web-platform-features`. This activates
  the experimental HTMLCanvasElement `configureHighDynamicRange` API and
  advanced `ScreenDetails` properties (such as `highDynamicRangeHeadroom`)
  needed to query your display's native HDR capacity and render HDR highlights
  correctly.

Note: Without these experimental features enabled, HDR Explorer will still
function but will fall back to SDR tone mapping or simulated headroom.

## Fundamental Concepts

### What is HDR?

Simply put, HDR (High Dynamic Range) videos and images can contain pixels that
are brighter than the standard maximum pixel brightness, e.g. white pixels
that are brighter than your normal sRGB #FFFFFF white.

In the context of computers and phone in particular, the normal maximum white
is typically set to a level that is comfortable to look at even if it covers
the whole screen. It's common for web pages to have a white background. This
white is conceptually similar to the white of a piece of paper in the physical
world. However, when a photo contains light sources (the sun, a lamp, a bright
window), or specular highlights (reflections on a shiny object) it may be
desirable to go higher than this maximum white in localized areas to create
greater contrast. This is what HDR allows.

Content that is *not* HDR is called SDR (Standard Dynamic Range).

To be able to display HDR content, the display and the software stack must
support HDR, otherwise the content will be displayed in SDR using tone mapping.
Many modern laptops support HDR, such as
[MacBooks from 2018+](https://support.apple.com/en-us/102205).

Note: for photos, the term HDR has traditionally been used to refer to
[multi-exposure HDR capture](https://en.wikipedia.org/wiki/Multi-exposure_HDR_capture),
where several shots of the same scene are merged together to produce an image
with greater detail in both shadows and highlights, but the final image is
actually still a normal SDR image. This is different from "true" HDR images
that are discussed here.

### Tone Mapping

[Tone Mapping](https://en.wikipedia.org/wiki/Tone_mapping) is the process of
adapting the pixel values of HDR content to make them fit in the brightness
range that the display supports. If the display does not support HDR, then the
pixel values must be tone mapped down to the SDR range. Even if the display
(and software) DO support HDR, the display may not be capable of displaying
pixels quite as bright as the content asks for. HDR capability is not just a
yes-or-no value; a display can be more or less "HDR" depending on the maximum
brightness it can produce (e.g. 600 nits, 1000 nits, 2000 nits...) and the
current brightness setting which determines the SDR white brightness.

Tone mapping is not a trivial process: without any extra information, it is
not easy to know how to best change the pixel values of an image to fit into a
reduced brightness range while keeping an acceptable local and global
contrast, overall brightness, and achieving a generally pleasant image.

Tone mapping can be local or global. A global tone mapping process applies the
exact same formula to each pixel regardless of its location, while a local tone
mapping process may adapt its formula for different areas of the image.
HDR Explorer deals with global tone mapping.

### The SDR-relative Model and Headroom

Traditional HDR standards like PQ often define brightness in absolute terms
(nits, i.e. candelas per square meter).
However, human vision is relative. We perceive a white piece of paper as
"white" whether we are in a dark room or outside in the sun because our eyes
adapt, even though the absolute brightness differs widely.

Similarly, on a computer or TV display, the SDR white value changes depending
on the current display brightness setting, but is still perceived as "white".

HDR Explorer and SMPTE ST 2094-50 use an SDR-relative approach.
This model represents HDR pixel values as relative to the SDR white.

The SDR maximum brightness has the value 1. Values below 1 are in the SDR
range. Values above 1 are in the HDR range. A value of 2 means "twice as
bright as the SDR maximum" (in linear terms), regardless of what the SDR
maximum brightness in nits is. Because the SDR white is used as a reference
point for HDR values, in this context it's also called the **HDR reference
white**.

Similarly, the display's HDR capacity is expressed with a relative value
called **headroom**. The display headroom is the ratio of the maximum
brightness that the display can produce, in nits, over the current SDR white
brightness. For example, if a display has a maximum brightness of 2000 nits,
and the display brightness setting is currently set so that SDR white is at
400 nits, then the linear headroom is 2000/400 = 5.
This headroom is often expressed in log2 "stops". In this example,
log2(5) ≈ 2.3, so we can say that the current log2 headroom of the display is
2.3 stops.

This headroom value is the "extra" brightness capability a display has *above*
the current SDR white level. A linear headroom of 5 means that the display can
show pixels with an SDR-relative value up to 5.

If the user takes their computer outside in the sun and the SDR white
brightness is increased to 1000, then the display's headroom will fall to
2000/1000 = 2, or log2(2) = 1 stop.

### HDR Metadata

As we saw, tone mapping is not a trivial process, so several
standards have been developed to add extra metadata to videos to aid this
process. This metadata can be static (values that apply to the whole video)
or dynamic (changing per frame).

The main examples are:

- HDR10 metadata (static): SMPTE ST 2086 (mastering display color volume),
  MaxFALL (maximum frame-average light level), and MaxCLL (maximum content
  light level).
- Dolby Vision (dynamic): SMPTE ST 2094-10.
- HDR10+ (dynamic): SMPTE ST 2094-40.
- SMPTE ST 2094-50 (dynamic): also called Headroom Adaptive Gain Curve (HAGC)
  or AGTM (Adaptive Global Tone Mapping) in the HDR Explorer source code.

Most of these metadata formats are descriptive. They provide some extra
information useful for tone mapping, but the display itself still decides how
to use this information to adapt the content. HDR10+ provides a reference
algorithm but it is simply a recommendation. This gives hardware manufacturers
and software providers the freedom to develop their own tone mapping
algorithms, but may lead to inconsistent rendering across devices, limiting
the content creators' ability to control the look of their content.

On the other hand, SMPTE ST 2094-50 is prescriptive: the metadata embedded in
the file contains specific "gain curves" and parameters that tell the display
exactly how to adjust the image based on the available headroom. This ensures
a consistent look across devices and more content creator control.

### HDR Transfer Functions

A transfer function defines the mathematical relationship between the digital
signal values in a video file and the desired linear light output to show on
a display. In standard dynamic range (SDR), this is traditionally handled by
a gamma curve (e.g., sRGB or BT.1886). For HDR content, two primary non-linear
transfer functions are established by the ITU-R BT.2100 standard to handle the
vastly increased dynamic range: **PQ**
([Perceptual Quantizer](https://en.wikipedia.org/wiki/Perceptual_quantizer))
and **HLG**
([Hybrid Log-Gamma](https://en.wikipedia.org/wiki/Hybrid_log%E2%80%93gamma)).
In-depth knowledge of these transfer functions is not necessary to use
HDR Explorer.

## HDR Explorer Controls

The HDR Explorer UI consists of four groups of controls, listed below,
below which various panels are shown.

### Content

When you open HDR Explorer, it loads a default video (a static indoor shot).
A number of other built-in sample files are provided, or you can select your
own with the dedicated button or by dragging and dropping a file.
When a custom file is loaded, some basic information about it is first shown
so that you can double check that the expected metadata (if any) was detected.

The content's transfer function and color primaries are automatically detected
when possible, but if not, they can be changed with the other controls in this
section.

### SMPTE ST 2094-50 Metadata

HDR Explorer focuses on the new standard for HDR metadata called
SMPTE ST 2094-50. If the video/image file contains embedded SMPTE ST 2094-50
metadata, then it will be used by default by the 2094-50 panels. Otherwise,
HDR Explorer will automatically generate SMPTE ST 2094-50 metadata. This section
allows you to inspect embedded metadata parameters or adjust the settings for
automatically generated metadata.

### Headroom

HDR Explorer allows manually adjusting the display's headroom to see the
effect on tone mapping. The headroom can be artificially lowered below the
display's real current headroom, or it can be increased by simulating the
headroom.

For best results, we recommend using HDR Explorer on an HDR-capable display
with experimental web platform features enabled.

- **Available Native Headroom:** This is a property of your display hardware
  and brightness setting. It's the maximum brightness your screen can achieve
  relative to the current SDR white level. This changes as you adjust your
  screen's brightness slider.
- **Headroom Slider:** This slider is used to adjust the headroom:
  - **Matching Native:** Click on the arrow (↓) above the slider so that the
    tool automatically follows the display's actual current headroom.
  - **Simulating LESS Headroom:** Moving the slider LEFT of the arrow
    restricts the amount of headroom used by the tool, simulating a
    lower-capacity display.
  - **Simulating MORE Headroom:** Moving the slider RIGHT of the arrow
    simulates a display with more HDR capability. The tool achieves this by
    darkening the entire page background. This makes the SDR white dimmer,
    creating "virtual" room for highlights to appear brighter in comparison.
    For best results, hide the UI elements using the `Escape` key, and switch
    the window to full screen (for full effect you do not want anything
    brighter than the darkened background to be visible).
- **Display Nits:** For the most accurate rendering (according to the
  specifications) of the HDR10+ panel and the HDR panel (when using HLG
  content), set the display nits value to the actual maximum nits of your
  display.

### Panels

The bottom half of the HDR Explorer interface consists of a number of
different panels that can be toggled on and off. See the tooltips for a
detailed description of each panel. The first few panels are "renderers" which
show the video/image. They can be shown all at once in "side-by-side" mode or
one at a time in "flip" mode. Use the `F` key to flip between panels and the
`S` key to go back to side-by-side mode.

Some panels have extra settings within them. A lot of panels also have a
download button at the top right that appears on hover. The 2094-50 renderer
panel in particular allows downloading the video with 2094-50 muxed in.

## Known Limitations

- HDR Explorer has been tested mainly on Chrome (version 131+ recommended) and
  requires specific experimental flags.
  It is not guaranteed to work on other browsers.
- The rendered images may show color banding because of the use of 8-bit
  buffers during tone mapping and display due to technical limitations.
