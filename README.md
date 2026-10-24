# PacketScope

Enter a URL and watch a real request cross the internet on a 3D globe: DNS resolution (root → TLD → authoritative), every router hop from a live TCP traceroute, the TCP and TLS handshakes, the HTTP request, and response packets streaming back. Timings come from real measurements.

- Backend: `server.py` (aiohttp). Uses `dig +trace`, `mtr` (TCP mode, needs sudo), `curl` timings, ip-api.com for geolocation, and reverse DNS.
- Frontend: `static/` with globe.gl bundled locally (no build step).
- Physics check: hops that reply faster than light in fiber could reach their geolocated position are flagged (anycast/CDN edges or unreliable geo).

Run: `sudo apt install mtr-tiny dnsutils curl && pip install aiohttp && python3 server.py`, then open http://localhost:8080.
Routes are traced from the machine running the server.
