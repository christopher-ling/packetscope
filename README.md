# PacketScope

Enter a URL and watch a real request cross the internet on a 3D globe: DNS resolution (root → TLD → authoritative), every router hop from a live TCP traceroute, the TCP and TLS handshakes, the HTTP request, and response packets streaming back. Timings come from real measurements.

- Backend: `server.py` (aiohttp). Uses `dig +trace`, `mtr` (TCP mode, needs sudo), `curl` timings, ip-api.com for geolocation, and reverse DNS.
- Frontend: `static/` with globe.gl bundled locally (no build step).
- Physics check: hops that reply faster than light in fiber could reach their geolocated position are flagged (anycast/CDN edges or unreliable geo).

Run: `sudo apt install mtr-tiny dnsutils curl && pip install aiohttp && python3 server.py`, then open http://localhost:8080.
Routes are traced from the machine running the server.

## Showing *your* location
- The visitor's IP (from `X-Forwarded-For` etc.) is geolocated and pinned as **YOU**; "Use my precise location" uses the browser Geolocation API instead.
- When the visitor isn't on the tracer machine, a dashed line links YOU to the tracer: that leg is **not measured** (browsers can't send traceroute probes).
- **Local mode:** run the server on your own laptop and open `http://localhost:8080` — the route is then measured from your network and starts at you. macOS: `brew install mtr && pip3 install aiohttp && sudo python3 server.py` (mtr needs root for TCP probes).
