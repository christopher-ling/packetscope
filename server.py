import asyncio
import ipaddress
import json
import re
import socket
import time
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
from aiohttp import web

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
HOST_RE = re.compile(r"^(?=.{1,253}$)([a-zA-Z0-9-]{1,63}\.)+[a-zA-Z]{2,63}$")
GEO_CACHE: dict = {}
SELF_INFO: dict = {}
AWS_REGIONS = {
    "us-west-2": (45.84, -119.70, "Boardman, Oregon (AWS us-west-2)"),
    "us-west-1": (37.35, -121.96, "San Jose, California (AWS us-west-1)"),
    "us-east-1": (39.04, -77.49, "Ashburn, Virginia (AWS us-east-1)"),
    "us-east-2": (40.00, -83.00, "Columbus, Ohio (AWS us-east-2)"),
    "eu-west-1": (53.35, -6.26, "Dublin, Ireland (AWS eu-west-1)"),
    "eu-central-1": (50.11, 8.68, "Frankfurt, Germany (AWS eu-central-1)"),
}


def parse_target(raw: str):
    raw = raw.strip()
    if "://" not in raw:
        raw = "https://" + raw
    u = urlparse(raw)
    host = (u.hostname or "").lower()
    if not HOST_RE.match(host):
        raise ValueError("Enter a public hostname like github.com")
    scheme = u.scheme if u.scheme in ("http", "https") else "https"
    port = u.port or (443 if scheme == "https" else 80)
    path = u.path or "/"
    return scheme, host, port, f"{scheme}://{host}{':' + str(u.port) if u.port else ''}{path}"


def is_public(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if a.version == 4 and a in ipaddress.ip_network("240.0.0.0/4"):
        return False
    return a.is_global


CITY_CODES = {
    "iad": (38.95, -77.45, "Ashburn, US"), "was": (38.90, -77.04, "Washington DC, US"), "dca": (38.90, -77.04, "Washington DC, US"),
    "ash": (39.04, -77.49, "Ashburn, US"), "nyc": (40.71, -74.01, "New York, US"), "jfk": (40.64, -73.78, "New York, US"),
    "ewr": (40.69, -74.17, "Newark, US"), "lga": (40.71, -74.01, "New York, US"), "bos": (42.36, -71.06, "Boston, US"),
    "phl": (39.95, -75.17, "Philadelphia, US"), "atl": (33.75, -84.39, "Atlanta, US"), "mia": (25.76, -80.19, "Miami, US"),
    "ord": (41.88, -87.63, "Chicago, US"), "chi": (41.88, -87.63, "Chicago, US"), "dfw": (32.78, -96.80, "Dallas, US"),
    "dal": (32.78, -96.80, "Dallas, US"), "hou": (29.76, -95.37, "Houston, US"), "den": (39.74, -104.99, "Denver, US"),
    "phx": (33.45, -112.07, "Phoenix, US"), "slc": (40.76, -111.89, "Salt Lake City, US"), "lax": (34.05, -118.24, "Los Angeles, US"),
    "sjc": (37.34, -121.89, "San Jose, US"), "sfo": (37.62, -122.38, "San Francisco, US"), "pao": (37.44, -122.14, "Palo Alto, US"),
    "sea": (47.61, -122.33, "Seattle, US"), "pdx": (45.52, -122.68, "Portland, US"), "yyz": (43.65, -79.38, "Toronto, CA"),
    "tor": (43.65, -79.38, "Toronto, CA"), "yvr": (49.28, -123.12, "Vancouver, CA"), "ymq": (45.50, -73.57, "Montreal, CA"),
    "lon": (51.51, -0.13, "London, GB"), "lhr": (51.47, -0.45, "London, GB"), "ams": (52.37, 4.90, "Amsterdam, NL"),
    "fra": (50.11, 8.68, "Frankfurt, DE"), "par": (48.86, 2.35, "Paris, FR"), "cdg": (49.01, 2.55, "Paris, FR"),
    "mad": (40.42, -3.70, "Madrid, ES"), "mil": (45.46, 9.19, "Milan, IT"), "sto": (59.33, 18.07, "Stockholm, SE"),
    "tyo": (35.68, 139.69, "Tokyo, JP"), "nrt": (35.77, 140.39, "Tokyo, JP"), "osa": (34.69, 135.50, "Osaka, JP"),
    "hkg": (22.32, 114.17, "Hong Kong, HK"), "sin": (1.35, 103.82, "Singapore, SG"), "syd": (-33.87, 151.21, "Sydney, AU"),
    "bom": (19.08, 72.88, "Mumbai, IN"), "sao": (-23.55, -46.63, "Sao Paulo, BR"), "gru": (-23.43, -46.47, "Sao Paulo, BR"),
    "jnb": (-26.20, 28.05, "Johannesburg, ZA"), "sel": (37.57, 126.98, "Seoul, KR"), "icn": (37.46, 126.44, "Seoul, KR"),
}
CODE_RE = re.compile(r"(?:^|[.\-])([a-z]{3})\d{0,2}(?=[.\-]|$)")


def rdns_location(name):
    if not name:
        return None
    labels = name.lower().split(".")
    for m in CODE_RE.finditer(".".join(labels[:-2]) if len(labels) > 2 else ""):
        if m.group(1) in CITY_CODES:
            return m.group(1), CITY_CODES[m.group(1)]
    return None


async def run(*args, timeout=30):
    p = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
    except asyncio.TimeoutError:
        p.kill()
        return ""
    return out.decode(errors="replace")


async def dns_trace(host: str):
    t0 = time.perf_counter()
    out = await run("dig", "+trace", "+nodnssec", "+tries=1", "+time=2", host, "A", timeout=15)
    steps = []
    answers = []
    for line in out.splitlines():
        m = re.match(r";; Received (\d+) bytes from ([0-9a-fA-F:.]+)#53\(([^)]*)\) in (\d+) ms", line)
        if m:
            size, ip, name, ms = m.groups()
            steps.append({"ip": ip, "name": name, "bytes": int(size), "ms": int(ms)})
            continue
        parts = line.split()
        if len(parts) >= 5 and parts[3] in ("A", "CNAME") and not line.startswith(";"):
            answers.append({"name": parts[0].rstrip("."), "type": parts[3], "value": parts[4].rstrip(".")})
    labels = ["Local resolver", "Root server", "TLD server", "Authoritative server"]
    for i, s in enumerate(steps):
        s["role"] = labels[i] if i < len(labels) else "Authoritative server"
    a_records = [a["value"] for a in answers if a["type"] == "A"]
    if not a_records:
        try:
            infos = await asyncio.get_running_loop().getaddrinfo(host, None, family=socket.AF_INET)
            a_records = sorted({i[4][0] for i in infos})
        except OSError:
            pass
    return {"steps": [s for s in steps if s["role"] != "Local resolver"], "answers": answers,
            "ips": a_records, "elapsed_ms": round((time.perf_counter() - t0) * 1000)}


async def traceroute(ip: str, port: int):
    out = await run("sudo", "-n", "mtr", "-j", "-n", "-c", "3", "-i", "0.2", "--gracetime", "1",
                    "-T", "-P", str(port), "-m", "30", ip, timeout=40)
    try:
        hubs = json.loads(out)["report"]["hubs"]
    except (ValueError, KeyError):
        return []
    hops = []
    for h in hubs:
        host = h.get("host", "???")
        hops.append({"ttl": h["count"], "ip": None if host == "???" else host,
                     "avg": h.get("Avg"), "best": h.get("Best"), "worst": h.get("Wrst"),
                     "loss": h.get("Loss%")})
    while hops and hops[-1]["ip"] is None:
        hops.pop()
    if not hops or hops[-1]["ip"] != ip:
        hops.append({"ttl": (hops[-1]["ttl"] + 1) if hops else 1, "ip": ip, "avg": None,
                     "best": None, "worst": None, "loss": None, "inferred": True})
    return hops


async def http_timing(url: str, ip: str, port: int, host: str):
    fmt = json.dumps({k: "%{" + k + "}" for k in [
        "time_namelookup", "time_connect", "time_appconnect", "time_pretransfer",
        "time_starttransfer", "time_total", "size_download", "size_header", "http_code",
        "remote_ip", "http_version", "num_redirects", "ssl_verify_result"]})
    out = await run("curl", "-s", "-L", "--max-redirs", "5", "-o", "/dev/null", "-D", "-", "-m", "15", "--compressed",
                    "--resolve", f"{host}:{port}:{ip}", "-A", "PacketScope/1.0", "-w", "\n@@" + fmt,
                    url, timeout=20)
    headers_raw, _, w = out.rpartition("\n@@")
    try:
        t = json.loads(w)
    except ValueError:
        return {"error": "HTTP request failed"}
    for k, v in list(t.items()):
        try:
            t[k] = float(v) if "." in str(v) else int(v)
        except (TypeError, ValueError):
            pass
    hdrs = {}
    status_line = ""
    for line in headers_raw.splitlines():
        if line.startswith("HTTP/"):
            status_line, hdrs = line.strip(), {}
        elif ":" in line:
            k, v = line.split(":", 1)
            hdrs[k.strip().lower()] = v.strip()
    keep = ["server", "content-type", "content-length", "cache-control", "via", "x-cache",
            "cf-ray", "x-served-by", "age", "alt-svc", "strict-transport-security"]
    t["status_line"] = status_line
    t["headers"] = {k: hdrs[k][:120] for k in keep if k in hdrs}
    return t


async def geolocate(ips):
    need = [ip for ip in dict.fromkeys(ips) if ip and is_public(ip) and ip not in GEO_CACHE]
    if need:
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8)) as s:
                for i in range(0, len(need), 100):
                    body = [{"query": ip, "fields": "status,query,lat,lon,city,regionName,country,countryCode,isp,org,as,asname"}
                            for ip in need[i:i + 100]]
                    async with s.post("http://ip-api.com/batch", json=body) as r:
                        for d in await r.json():
                            if d.get("status") == "success":
                                GEO_CACHE[d["query"]] = d
        except Exception:
            pass
    return {ip: GEO_CACHE[ip] for ip in ips if ip in GEO_CACHE}


async def rdns(ips):
    loop = asyncio.get_running_loop()

    async def one(ip):
        try:
            return ip, (await asyncio.wait_for(loop.run_in_executor(None, socket.gethostbyaddr, ip), 2))[0]
        except Exception:
            return ip, None
    res = await asyncio.gather(*[one(ip) for ip in dict.fromkeys(ips) if ip])
    return {ip: name for ip, name in res if name}


async def self_info():
    if not SELF_INFO:
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as s:
                async with s.get("http://ip-api.com/json/?fields=status,query,lat,lon,city,regionName,country,countryCode,isp,org,as") as r:
                    SELF_INFO.update(await r.json())
        except Exception:
            SELF_INFO.update({"query": "unknown", "lat": 37.34, "lon": -121.89, "city": "Unknown", "country": ""})
    return SELF_INFO


async def trace_handler(request: web.Request):
    resp = web.StreamResponse(headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                                       "X-Accel-Buffering": "no"})
    await resp.prepare(request)

    async def send(event, data):
        await resp.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())

    try:
        scheme, host, port, url = parse_target(request.query.get("url", ""))
    except ValueError as e:
        await send("fail", {"error": str(e)})
        return resp

    me = await self_info()
    await send("start", {"host": host, "url": url, "scheme": scheme, "port": port, "client": me})

    dns = await dns_trace(host)
    if not dns["ips"]:
        await send("fail", {"error": f"Could not resolve {host}"})
        return resp
    ip = dns["ips"][0]
    dns_geo = await geolocate([s["ip"] for s in dns["steps"]] + [ip])
    await send("dns", {**dns, "geo": dns_geo, "target_ip": ip})

    trace_task = asyncio.create_task(traceroute(ip, port))
    http_task = asyncio.create_task(http_timing(url, ip, port, host))
    await send("status", {"msg": f"Tracing route to {ip} (TCP/{port})…"})
    hops = await trace_task
    hop_ips = [h["ip"] for h in hops if h["ip"]]
    geo, names = await asyncio.gather(geolocate(hop_ips), rdns(hop_ips))
    for h in hops:
        if h["ip"]:
            h["geo"] = geo.get(h["ip"])
            h["rdns"] = names.get(h["ip"])
            h["private"] = not is_public(h["ip"])
            hint = rdns_location(h["rdns"]) if not h["private"] else None
            if hint:
                code, (lat, lon, city) = hint
                g = dict(h["geo"] or {})
                if g:
                    g["db_city"] = g.get("city")
                c, cc = city.split(", ")
                g.update({"lat": lat, "lon": lon, "city": c, "country": g.get("country") if g.get("countryCode") == cc else cc,
                          "countryCode": cc, "hint": code.upper()})
                h["geo"] = g
    probe = None
    for h in hops:
        m = re.search(r"\.((?:us|eu|ap|ca|sa)-[a-z]+-\d)\.compute\.internal", h.get("rdns") or "")
        if m and m.group(1) in AWS_REGIONS:
            lat, lon, city = AWS_REGIONS[m.group(1)]
            probe = {"lat": lat, "lon": lon, "city": city}
            break
    await send("route", {"hops": hops, "target_ip": ip, "probe": probe})
    await send("http", await http_task)
    await send("done", {})
    return resp


async def index(_):
    return web.FileResponse(STATIC / "index.html")


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/api/trace", trace_handler)
app.router.add_static("/", STATIC)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=8080)
