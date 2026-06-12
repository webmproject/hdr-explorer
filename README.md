# HDR Explorer

HDR Explorer is a web-based tool for visualization and experimentation with High
Dynamic Range (HDR) video and images, focusing particularly on the
[SMPTE ST 2094-50](https://github.com/SMPTE/st2094-50) standard.

Note that it has been tested mainly on Chrome and is not guaranteed to work on
other browsers.

[LIVE DEMO](https://webmproject.github.io/hdr-explorer/)

## Getting Started

```
npm install

npm run dev
# or
npm run build && npm run preview
```

If you need to access the app from a different IP, run:

```
# Instead of `npm run dev`:
npx vite --host 0.0.0.0
# Or instead of `npm run preview`:
npx vite preview --host 0.0.0.0

# If you get "Blocked request, this host (....) is not allowed", when accessing
# the server, set this env var before running the commands above
# (see https://vite.dev/config/server-options#server-allowedhosts)
export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<fill in host name>
```

## User Guide

See the [user guide here](USAGE.md).

## License

HDR Explorer is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.

## Disclaimer

This is not an officially supported Google product. This project is not
eligible for the [Google Open Source Software Vulnerability Rewards
Program](https://bughunters.google.com/open-source-security).
