const COLORS = { dns: '#ffb547', tcp: '#3ee7ff', tls: '#b37bff', http: '#4dff9a', data: '#ff4fb3', route: 'rgba(120,170,255,0.35)' };
const PHASES = [['dns', 'DNS', COLORS.dns], ['tcp', 'TCP', COLORS.tcp], ['tls', 'TLS', COLORS.tls], ['http', 'Wait (TTFB)', COLORS.http], ['data', 'Download', COLORS.data]];
const EXAMPLES = ['github.com', 'wikipedia.org', 'bbc.co.uk', 'gatech.edu', 'yahoo.co.jp', 'baidu.com', 'gov.za'];
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (cc) => (cc ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let state = null;
let runId = 0;
let arcs = [], rings = [];
let speed = 1;
let me = null;

const world = Globe()($('globe'))
  .globeImageUrl('vendor/earth-night.jpg')
  .bumpImageUrl('vendor/earth-topology.png')
  .backgroundImageUrl('vendor/night-sky.png')
  .atmosphereColor('#3a7bff')
  .atmosphereAltitude(0.18)
  .arcColor((d) => d.color)
  .arcStroke((d) => d.stroke)
  .arcAltitudeAutoScale((d) => d.autoScale ?? 0.4)
  .arcDashLength((d) => d.dashLength)
  .arcDashGap((d) => d.dashGap)
  .arcDashInitialGap((d) => d.initialGap)
  .arcDashAnimateTime((d) => d.animate)
  .arcsTransitionDuration(0)
  .ringColor((d) => (t) => hexA(d.color, 1 - t))
  .ringMaxRadius((d) => d.max ?? 3)
  .ringPropagationSpeed((d) => d.speed ?? 4)
  .ringRepeatPeriod((d) => d.repeat ?? 0)
  .pointColor((d) => d.color)
  .pointAltitude(0.008)
  .pointRadius((d) => d.r)
  .pointsMerge(false)
  .pointLabel((d) => d.label)
  .labelText((d) => d.text)
  .labelSize((d) => d.size ?? 0.9)
  .labelDotRadius(0)
  .labelColor((d) => d.color ?? 'rgba(220,230,255,0.85)')
  .labelResolution(2)
  .labelAltitude(0.01);
world.controls().autoRotate = true;
world.controls().autoRotateSpeed = 0.35;
world.pointOfView({ lat: 25, lng: -40, altitude: 2.4 });
window.addEventListener('resize', () => world.width(innerWidth).height(innerHeight));

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, a).toFixed(3)})`;
}
function km(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- UI scaffolding ---------- */
$('chips').innerHTML = EXAMPLES.map((e) => `<span class="chip">${e}</span>`).join('');
$('chips').onclick = (e) => { if (e.target.classList.contains('chip')) { $('url').value = e.target.textContent; start(); } };
$('form').onsubmit = (e) => { e.preventDefault(); start(); };
$('speed').oninput = (e) => { speed = +e.target.value; };
$('replay').onclick = () => state && animate(state);
$('locate').onclick = () => {
  if (!navigator.geolocation) { $('meInfo').textContent = 'Geolocation not supported — using IP estimate.'; return; }
  $('meInfo').textContent = 'Asking your browser…';
  navigator.geolocation.getCurrentPosition((p) => {
    me = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
    $('locate').classList.add('on');
    $('meInfo').textContent = `Pinned ${me.lat.toFixed(3)}, ${me.lon.toFixed(3)} (±${Math.round(me.acc)} m)`;
    if (state) { build(state); animate(state); }
  }, (err) => { $('meInfo').textContent = `Location ${err.code === 1 ? 'denied' : 'unavailable'} — using IP estimate.`; },
  { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 });
};
$('legend').innerHTML = [['dns', 'DNS lookup'], ['tcp', 'TCP handshake'], ['tls', 'TLS handshake'], ['http', 'HTTP request'], ['data', 'Response data']]
  .map(([k, l]) => `<span><i style="background:${COLORS[k]};box-shadow:0 0 8px ${COLORS[k]}"></i>${l}</span>`).join('');
renderWaterfall(null);
$('hops').innerHTML = '<div class="empty">Hops will appear here — every router your packets pass through.</div>';
$('log').innerHTML = '<div class="empty">Packet events will stream here.</div>';

function setStatus(msg, err) { $('status').textContent = msg; $('status').className = 'status' + (err ? ' err' : ''); }
function log(color, html) {
  const el = document.createElement('div');
  const t = ((performance.now() - (state?.t0 || performance.now())) / 1000).toFixed(2).padStart(5, ' ');
  el.innerHTML = `<span class="t">${t}s</span> <span style="color:${color}">●</span> ${html}`;
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
}
function banner(text, color) {
  const b = $('phaseBanner');
  b.textContent = text; b.style.color = color; b.classList.add('show');
}

/* ---------- data fetch ---------- */
function start() {
  const url = $('url').value.trim();
  if (!url) return;
  const id = ++runId;
  state = null;
  arcs = []; rings = [];
  world.arcsData([]).ringsData([]).pointsData([]).labelsData([]);
  $('go').disabled = true; $('replay').disabled = true;
  $('log').innerHTML = ''; $('hops').innerHTML = ''; $('stats').innerHTML = ''; $('hopCount').textContent = ''; $('totalMs').textContent = '';
  renderWaterfall(null);
  setStatus(`Resolving ${url}…`);
  world.controls().autoRotate = false;
  const data = { t0: performance.now() };
  const es = new EventSource('/api/trace?url=' + encodeURIComponent(url));
  const finish = () => { es.close(); if (id === runId) $('go').disabled = false; };
  es.addEventListener('start', (e) => { Object.assign(data, JSON.parse(e.data)); setStatus(`Asking DNS where ${data.host} lives…`); });
  es.addEventListener('dns', (e) => { data.dns = JSON.parse(e.data); setStatus(`${data.host} → ${data.dns.target_ip}. Tracing the route hop by hop…`); });
  es.addEventListener('status', (e) => setStatus(JSON.parse(e.data).msg));
  es.addEventListener('route', (e) => { data.route = JSON.parse(e.data); });
  es.addEventListener('http', (e) => { data.http = JSON.parse(e.data); });
  es.addEventListener('fail', (e) => { setStatus(JSON.parse(e.data).error, true); finish(); });
  es.addEventListener('done', () => { finish(); if (id !== runId) return; build(data); state = data; animate(data); });
  es.onerror = () => { if (!data.route) setStatus('Connection to the tracer failed — try again.', true); finish(); };
}

/* ---------- model ---------- */
function build(d) {
  d.client = { ...(d.client0 ??= d.client), ...(d.route.probe || {}) };
  const local = !!d.viewer?.same_as_probe;
  if (local && me) d.client = { ...d.client, lat: me.lat, lon: me.lon };
  const c = d.client;
  d.clientNode = { lat: c.lat, lng: c.lon, name: `${local ? 'You' : 'Tracer'} · ${c.city}`, ip: c.query, cc: c.countryCode, kind: 'client' };
  d.viewerNode = null;
  if (!local) {
    const ipv = d.viewer?.lat != null ? d.viewer : null;
    const v = me || ipv;
    if (v) {
      const near = ipv && km({ lat: v.lat, lng: v.lon }, { lat: ipv.lat, lng: ipv.lon }) < 150;
      const city = near ? ipv.city : 'your location';
      d.viewerNode = { lat: v.lat, lng: v.lon, city, precise: !!me, ip: ipv?.query, isp: ipv?.isp };
      if (km(d.viewerNode, d.clientNode) < 50) d.viewerNode = null;
    }
  }
  const hops = d.route.hops;
  let last = { lat: c.lat, lng: c.lon };
  hops.forEach((h) => {
    if (!h.geo || h.best == null) return;
    const minMs = (km(d.clientNode, { lat: h.geo.lat, lng: h.geo.lon }) * 2) / 200;
    if (h.best < minMs * 0.6 && minMs > 10) { h.anycast = { claimed: h.geo, minMs }; h.geo = null; }
  });
  const tgtHop = hops[hops.length - 1];
  if (tgtHop.anycast || (!tgtHop.geo && d.dns.geo[d.dns.target_ip])) {
    const g = d.dns.geo[d.dns.target_ip];
    if (g && !tgtHop.anycast) {
      const minMs = (km(d.clientNode, { lat: g.lat, lng: g.lon }) * 2) / 200;
      const rtt = [...hops].reverse().find((h) => h.best != null)?.best;
      if (rtt != null && rtt < minMs * 0.6 && minMs > 10) tgtHop.anycast = { claimed: g, minMs };
    }
  }
  d.anycast = !!tgtHop.anycast;
  const lastGeo = [...hops].reverse().find((h) => h.geo);
  hops.forEach((h) => {
    if (h.geo) last = { lat: h.geo.lat, lng: h.geo.lon };
    h.lat = last.lat; h.lng = last.lng;
  });
  const tgt = hops[hops.length - 1];
  if (!tgt.geo && lastGeo && !tgt.anycast) { tgt.lat = lastGeo.geo.lat; tgt.lng = lastGeo.geo.lon; }
  if (km(tgt, { lat: c.lat, lng: c.lon }) < 60) { tgt.lat = c.lat - 1.2; tgt.lng = c.lon + 1.8; }
  // path nodes: collapse consecutive hops at the same spot
  const nodes = [{ ...d.clientNode, hopIdx: -1 }];
  hops.forEach((h, i) => {
    const prev = nodes[nodes.length - 1];
    if (km(prev, h) < 25) { prev.hopIdxs = [...(prev.hopIdxs || [prev.hopIdx]), i]; return; }
    nodes.push({ lat: h.lat, lng: h.lng, hopIdx: i, name: h.geo ? `${h.geo.city}, ${h.geo.countryCode}` : h.ip });
  });
  const serverGeo = tgt.anycast ? null : (d.dns.geo[d.dns.target_ip] || tgt.geo);
  d.serverNode = { lat: tgt.lat, lng: tgt.lng, name: `${d.host}${serverGeo ? ' · ' + serverGeo.city : ' · nearby edge'}`, kind: 'server' };
  if (nodes.length === 1) nodes.push({ ...d.serverNode, hopIdx: hops.length - 1 });
  d.nodes = nodes;
  d.distance = nodes.slice(1).reduce((s, n, i) => s + km(nodes[i], n), 0);
  d.dnsNodes = d.dns.steps.map((s) => {
    const g = d.dns.geo[s.ip];
    return g ? { lat: g.lat, lng: g.lon, ...s, city: g.city, cc: g.countryCode } : null;
  }).filter(Boolean);

  const pts = [];
  const lbl = new Map();
  pts.push({ lat: c.lat, lng: c.lon, r: 0.55, color: '#ffffff', label: `<b>${local ? 'You (tracer)' : 'Tracer'}</b><br>${c.query}<br>${c.city}, ${c.country}` });
  lbl.set('c', { lat: c.lat, lng: c.lon, text: `${local ? 'YOU' : 'TRACER'} · ${c.city.split(' (')[0]}`, color: local ? '#ffffff' : '#9fb4e8', size: 1.1 });
  const v = d.viewerNode;
  if (v) {
    pts.push({ lat: v.lat, lng: v.lng, r: 0.65, color: '#ffffff', label: `<b>You</b><br>${v.precise ? 'Browser location' : 'Estimated from your IP'}${v.ip ? '<br>' + v.ip : ''}${v.isp ? '<br>' + esc(v.isp) : ''}` });
    lbl.set('v', { lat: v.lat, lng: v.lng, text: `YOU · ${v.city}`, color: '#ffffff', size: 1.2 });
  }
  hops.forEach((h) => {
    if (!h.geo) return;
    pts.push({ lat: h.lat, lng: h.lng, r: 0.32, color: COLORS.tcp, label: `<b>Hop ${h.ttl}</b><br>${h.ip}<br>${esc(h.rdns || '')}<br>${h.geo.city}, ${h.geo.country}<br>${esc(h.geo.as || '')}` });
    const key = `${h.geo.city}`;
    if (!lbl.has(key) && km(h, d.clientNode) > 25 && km(h, tgt) > 25) lbl.set(key, { lat: h.lat, lng: h.lng, text: h.geo.city });
  });
  pts.push({ lat: d.serverNode.lat, lng: d.serverNode.lng, r: 0.6, color: COLORS.data, label: `<b>${esc(d.host)}</b><br>${d.dns.target_ip}` });
  lbl.set('s', { lat: d.serverNode.lat - 0.6, lng: d.serverNode.lng + 0.4, text: d.anycast ? d.host.toUpperCase() + ' (EDGE)' : d.host.toUpperCase(), color: COLORS.data, size: 1.1 });
  d.dnsNodes.forEach((n) => pts.push({ lat: n.lat, lng: n.lng, r: 0.28, color: COLORS.dns, label: `<b>${n.role}</b><br>${n.name}<br>${n.ip}<br>${n.city}` }));
  const all = nodes.concat(d.dnsNodes);
  const span = Math.max(...nodes.concat(v ? [v] : []).map((n) => km(n, nodes[0])), 300);
  const sc = Math.min(1, Math.max(0.22, span / 3500));
  pts.forEach((p) => { p.r *= sc; });
  const kept = [];
  [lbl.get('v'), lbl.get('s'), lbl.get('c'), ...[...lbl.entries()].filter(([k]) => !'vsc'.includes(k)).map(([, x]) => x)].filter(Boolean).forEach((l) => {
    if (kept.some((k) => km(k, l) < Math.max(span / 12, 40))) return;
    kept.push({ ...l, size: (l.size ?? 0.9) * sc });
  });
  d.points = pts;
  d.labels = kept;
  d.routeArcs = nodes.slice(1).map((n, i) => ({ startLat: nodes[i].lat, startLng: nodes[i].lng, endLat: n.lat, endLng: n.lng,
    color: COLORS.route, stroke: 0.25, dashLength: 1, dashGap: 0, initialGap: 0, animate: 0, static: true }));
  if (v) d.routeArcs.push({ startLat: v.lat, startLng: v.lng, endLat: c.lat, endLng: c.lon, color: 'rgba(255,255,255,0.55)',
    stroke: 0.3, dashLength: 0.02, dashGap: 0.015, initialGap: 0, animate: 0, autoScale: 0.25, static: true });
}

/* ---------- rendering helpers ---------- */
function pushArc(a) { arcs.push(a); world.arcsData([...arcs]); }
function dropArc(a) { arcs = arcs.filter((x) => x !== a); world.arcsData([...arcs]); }
function ring(lat, lng, color, max = 2.5) {
  const r = { lat, lng, color, max, speed: 3 };
  rings.push(r); world.ringsData([...rings]);
  setTimeout(() => { rings = rings.filter((x) => x !== r); world.ringsData([...rings]); }, 1400);
}
function litHop(idx) {
  document.querySelectorAll('.hop.lit').forEach((e) => e.classList.remove('lit'));
  if (idx == null || idx < 0) return;
  const el = document.querySelector(`.hop[data-i="${idx}"]`);
  if (el) { el.classList.add('lit'); el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

function flyArc(a, b, color, ms, stroke = 0.9) {
  const arc = { startLat: a.lat, startLng: a.lng, endLat: b.lat, endLng: b.lng, color, stroke,
    dashLength: 0.35, dashGap: 4, initialGap: 1, animate: ms };
  pushArc(arc);
  setTimeout(() => dropArc(arc), ms * 1.5);
  return sleep(ms).then(() => ring(b.lat, b.lng, color));
}

async function travel(path, color, id, { stroke = 0.9, light = true } = {}) {
  for (let i = 1; i < path.length; i++) {
    if (id !== runId) return;
    const d = km(path[i - 1], path[i]);
    const ms = (260 + Math.min(d, 12000) * 0.09) / speed;
    await flyArc(path[i - 1], path[i], color, ms, stroke);
    if (light) litHop(path[i].hopIdx);
  }
}

/* ---------- main animation ---------- */
async function animate(d) {
  const id = ++runId;
  d.t0 = performance.now();
  arcs = [...d.routeArcs]; rings = [];
  world.arcsData([...arcs]).ringsData([]).pointsData(d.points).labelsData(d.labels);
  $('log').innerHTML = '';
  $('replay').disabled = true;
  renderHops(d); renderStats(d); renderWaterfall(d.http, d.dns);
  const vn = d.viewerNode ? [d.viewerNode] : [];
  const mid = midpoint(d.nodes.concat(d.dnsNodes, vn));
  world.pointOfView({ lat: mid.lat, lng: mid.lng, altitude: mid.alt }, 1500 / speed);
  await sleep(1300 / speed);
  const fwd = d.nodes, back = [...d.nodes].reverse();
  const h = d.http || {};
  const ms = (x) => (x * 1000).toFixed(1) + ' ms';
  const port = d.port, sport = 40000 + Math.floor(Math.random() * 20000);
  const c = d.clientNode;
  setStatus(`${d.host} · ${d.dns.target_ip} · ${d.route.hops.length} hops · ${Math.round(d.distance).toLocaleString()} km of cable`);
  if (d.viewerNode) {
    const v = d.viewerNode;
    log('#ffffff', `<b>You</b> are in ${esc(v.city)} (${v.precise ? 'browser location' : 'IP estimate'}). Browsers can't send traceroute probes, so this route was measured from the tracer in ${esc(c.name.split(' · ')[1].split(' (')[0])} — dashed line = not measured. Run PacketScope on your own machine to trace from your network.`);
  }
  if (d.route.hops.length > 1 && d.route.hops.slice(0, -1).every((h) => !h.ip)) {
    log('#ff7a7a', `<b>Every router on this network stayed silent.</b> Your network (or VPN) blocks the ICMP "time exceeded" replies traceroute relies on, so only the server is visible. Try another network, e.g. a phone hotspot, to reveal the hops.`);
  }
  if (d.viewerNode) {
  } else if (d.viewer?.same_as_probe) {
    log('#ffffff', `<b>Local mode</b> — the tracer is running on your machine, so every hop below is your real path${me ? ' (pinned to your browser location)' : ''}.`);
  }

  // DNS
  phase('dns'); banner('1 · DNS lookup — where is ' + d.host + '?', COLORS.dns);
  for (const n of d.dnsNodes) {
    if (id !== runId) return;
    log(COLORS.dns, `DNS query <b>${esc(d.host)}</b> A? → ${n.role} <span class="t">${esc(n.name)} (${n.city})</span>`);
    await flyArc(c, n, COLORS.dns, 600 / speed, 0.7);
    await flyArc(n, c, COLORS.dns, 600 / speed, 0.7);
    log(COLORS.dns, n.role === 'Authoritative server'
      ? `Answer: <b>${esc(d.host)} = ${d.dns.target_ip}</b> <span class="t">${n.ms} ms</span>`
      : `Referral from ${n.role.toLowerCase()} <span class="t">${n.ms} ms</span>`);
  }
  if (!d.dnsNodes.length) log(COLORS.dns, `Resolved ${esc(d.host)} → <b>${d.dns.target_ip}</b>`);

  if (id !== runId) return;
  const rmid = midpoint(d.nodes.concat(vn));
  world.pointOfView({ lat: rmid.lat, lng: rmid.lng, altitude: rmid.alt }, 1200 / speed);
  await sleep(900 / speed);
  // TCP
  phase('tcp'); banner('2 · TCP 3-way handshake', COLORS.tcp);
  log(COLORS.tcp, `<b>SYN</b> ${c.ip}:${sport} → ${d.dns.target_ip}:${port} seq=0 win=64240`);
  await travel(fwd, COLORS.tcp, id);
  log(COLORS.tcp, `<b>SYN-ACK</b> ${d.dns.target_ip}:${port} → ${c.ip}:${sport} seq=0 ack=1`);
  await travel(back, COLORS.tcp, id);
  log(COLORS.tcp, `<b>ACK</b> connection established <span class="t">measured ${h.time_connect != null ? ms(h.time_connect) : '?'}</span>`);
  travel(fwd, COLORS.tcp, id, { stroke: 0.5, light: false });
  await sleep(500 / speed);

  if (d.scheme === 'https' && id === runId) {
    phase('tls'); banner('3 · TLS handshake — encrypting the connection', COLORS.tls);
    log(COLORS.tls, `<b>ClientHello</b> SNI=${esc(d.host)} · TLS 1.3 · key share`);
    await travel(fwd, COLORS.tls, id);
    log(COLORS.tls, `<b>ServerHello</b> + certificate + Finished`);
    await travel(back, COLORS.tls, id);
    log(COLORS.tls, `<b>Finished</b> keys agreed <span class="t">measured ${h.time_appconnect ? ms(h.time_appconnect - h.time_connect) : '?'}</span>`);
  }

  if (id !== runId) return;
  phase('http'); banner('4 · HTTP request', COLORS.http);
  log(COLORS.http, `<b>GET ${esc(new URL(d.url).pathname)}</b> Host: ${esc(d.host)} <span class="t">HTTP/${h.http_version || '1.1'}</span>`);
  await travel(fwd, COLORS.http, id);
  log(COLORS.http, `Server thinking… <span class="t">time to first byte ${h.time_starttransfer ? ms(h.time_starttransfer - h.time_pretransfer) : '?'}</span>`);
  ring(d.serverNode.lat, d.serverNode.lng, COLORS.http, 5);
  await sleep(500 / speed);

  if (id !== runId) return;
  phase('data'); banner('5 · Response — data flows back to you', COLORS.data);
  const bytes = (h.size_download || 0) + (h.size_header || 0);
  const pkts = Math.max(1, Math.ceil(bytes / 1448));
  log(COLORS.data, `<b>${esc(h.status_line || 'HTTP ' + (h.http_code || '?'))}</b> ${esc(h.headers?.['content-type'] || '')}`);
  log(COLORS.data, `${(bytes / 1024).toFixed(1)} KB ≈ <b>${pkts} TCP segments</b> of ≤1448 B streaming back`);
  const shown = Math.min(pkts, 14);
  const flights = [];
  for (let i = 0; i < shown; i++) {
    if (id !== runId) return;
    flights.push(travel(back, COLORS.data, id, { stroke: 0.7, light: i === 0 }));
    await sleep(170 / speed);
  }
  await Promise.all(flights);
  if (id !== runId) return;
  if (d.anycast) log(COLORS.dns, `<b>Physics check:</b> ${esc(d.host)} answered faster than light could reach its registered location — you were served by a nearby <b>anycast/CDN edge</b>, not the origin.`);
  if (h.num_redirects) log(COLORS.http, `Followed ${h.num_redirects} redirect(s) before the final page`);
  phase('done');
  log('#ffffff', `Done — page delivered in <b>${h.time_total ? ms(h.time_total) : '?'}</b> across ${d.route.hops.length} routers`);
  if (h.headers) Object.entries(h.headers).slice(0, 5).forEach(([k, v]) => log('#5a6a90', `<span class="t">${esc(k)}:</span> ${esc(v)}`));
  $('phaseBanner').classList.remove('show');
  litHop(null);
  $('replay').disabled = false;
  world.controls().autoRotate = true;
}

function midpoint(nodes) {
  const v = nodes.reduce((a, n) => {
    const la = n.lat * Math.PI / 180, lo = n.lng * Math.PI / 180;
    return [a[0] + Math.cos(la) * Math.cos(lo), a[1] + Math.cos(la) * Math.sin(lo), a[2] + Math.sin(la)];
  }, [0, 0, 0]);
  const lng = Math.atan2(v[1], v[0]) * 180 / Math.PI;
  const lat = Math.atan2(v[2], Math.hypot(v[0], v[1])) * 180 / Math.PI;
  const spread = Math.max(...nodes.map((n) => km(n, { lat, lng })));
  return { lat, lng, alt: Math.min(3.2, Math.max(0.7, spread / 3000 + 0.4)) };
}

/* ---------- panels ---------- */
function renderWaterfall(h, dns) {
  if (!h) { $('waterfall').innerHTML = PHASES.map(([k, n, col]) => `<div class="wf-row" data-k="${k}"><span class="wf-name">${n}</span><div class="wf-track"></div><span class="wf-ms">—</span></div>`).join(''); return; }
  const dnsMs = dns ? dns.steps.reduce((s, x) => s + x.ms, 0) : 0;
  const seg = {
    dns: dnsMs,
    tcp: (h.time_connect || 0) * 1000,
    tls: h.time_appconnect ? (h.time_appconnect - h.time_connect) * 1000 : 0,
    http: ((h.time_starttransfer || 0) - (h.time_pretransfer || 0)) * 1000,
    data: ((h.time_total || 0) - (h.time_starttransfer || 0)) * 1000,
  };
  const total = Object.values(seg).reduce((a, b) => a + b, 0) || 1;
  $('totalMs').textContent = total.toFixed(0) + ' ms total';
  let off = 0;
  $('waterfall').innerHTML = PHASES.map(([k, n, col]) => {
    const w = (seg[k] / total) * 100, l = off; off += w;
    return `<div class="wf-row" data-k="${k}"><span class="wf-name">${n}</span><div class="wf-track"><div class="wf-bar" style="left:${l}%;width:${Math.max(w, 0.8)}%;background:${col};color:${col}"></div></div><span class="wf-ms">${seg[k].toFixed(1)}ms</span></div>`;
  }).join('');
}
function phase(k) {
  let reached = false;
  document.querySelectorAll('.wf-row').forEach((r) => {
    r.classList.remove('active');
    if (r.dataset.k === k) { r.classList.add('active'); reached = true; } else if (!reached || k === 'done') r.classList.add('done');
  });
}
function renderHops(d) {
  const hops = d.route.hops;
  const maxMs = Math.max(1, ...hops.map((h) => h.avg || 0));
  $('hopCount').textContent = `${hops.length} hops`;
  $('hops').innerHTML = hops.map((h, i) => {
    if (!h.ip) return `<div class="hop" data-i="${i}"><span class="n">${h.ttl}</span><div><div class="ip">* * *</div><div class="meta">router didn't reply (filtered)</div></div><span></span></div>`;
    const g = h.geo;
    const where = h.anycast && i < hops.length - 1 ? `geo says ${esc(h.anycast.claimed.city)}, ${esc(h.anycast.claimed.countryCode)}, but a ${h.best.toFixed(1)}ms reply is impossible from there — location unreliable` : h.anycast ? `registered in ${esc(h.anycast.claimed.city)}, ${esc(h.anycast.claimed.countryCode)} — but ${h.best.toFixed(1)}ms is faster than light allows (min ${h.anycast.minMs.toFixed(0)}ms). Anycast/CDN edge near you.` : g ? `${esc(g.city)}, ${esc(g.country)}` : (h.private ? 'private network' : 'unknown location');
    const tags = (h.private ? '<span class="tag">private</span>' : '') + (h.anycast ? `<span class="tag" style="color:var(--dns)">${i === hops.length - 1 ? 'anycast' : 'geo?'}</span>` : '') + (i === hops.length - 1 ? '<span class="tag" style="color:var(--data)">server</span>' : '');
    return `<div class="hop" data-i="${i}"><span class="n">${h.ttl}</span><div><div class="ip">${h.ip}${tags}</div>
      <div class="meta">${where}${g?.hint ? ` <span class="tag" title="Located from router name code ${g.hint}${g.db_city ? '; geo database said ' + esc(g.db_city) : ''}">via ${g.hint}</span>` : ''}${(g || h.anycast?.claimed)?.as ? ' · ' + esc((g || h.anycast.claimed).as) : ''}</div>${h.rdns ? `<div class="meta">${esc(h.rdns)}</div>` : ''}
      <div class="bar" style="width:${((h.avg || 0) / maxMs) * 100}%"></div></div><span class="ms">${h.avg != null ? h.avg.toFixed(1) + 'ms' : ''}</span></div>`;
  }).join('');
  $('hops').querySelectorAll('.hop').forEach((el) => el.onclick = () => {
    const h = hops[+el.dataset.i];
    if (h.lat == null) return;
    world.controls().autoRotate = false;
    world.pointOfView({ lat: h.lat, lng: h.lng, altitude: 0.8 }, 900);
    ring(h.lat, h.lng, COLORS.tcp, 4);
    litHop(+el.dataset.i);
  });
}
function renderStats(d) {
  const rtt = [...d.route.hops].reverse().find((h) => h.avg)?.avg;
  const lightRtt = (d.distance * 2) / 200; // fiber ≈ 200 km/ms
  const asns = new Set(d.route.hops.map((h) => h.geo?.as?.split(' ')[0]).filter(Boolean));
  const countries = new Set(d.route.hops.map((h) => h.geo?.countryCode).filter(Boolean));
  $('stats').innerHTML = [
    [Math.round(d.distance).toLocaleString() + ' km', 'path distance'],
    [rtt ? rtt.toFixed(1) + ' ms' : '—', 'round trip'],
    [lightRtt.toFixed(1) + ' ms', 'speed-of-light min'],
    [`${asns.size} / ${countries.size}`, 'networks / countries'],
  ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
}
