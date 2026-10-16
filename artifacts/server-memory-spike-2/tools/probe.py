# probe.py PID LABEL [SERVER_PORT] -> one JSON line: /proc metrics, children by name, socket classes.
import json, os, re, subprocess, sys, time, collections

pid, label = sys.argv[1], sys.argv[2]
sport = int(sys.argv[3]) if len(sys.argv) > 3 else 4096
r = f"/proc/{pid}"


def kv(path):
    out = {}
    for line in open(path):
        k, _, v = line.partition(":")
        out[k.strip()] = v.strip()
    return out


st, roll = kv(f"{r}/status"), kv(f"{r}/smaps_rollup")
kb = lambda s: int(s.split()[0])
fds = collections.Counter()
sock_inodes = {}
for fd in os.listdir(f"{r}/fd"):
    try:
        t = os.readlink(f"{r}/fd/{fd}")
    except OSError:
        continue
    if t == "/dev/ptmx": fds["ptmx"] += 1
    elif t.startswith("/dev/pts/"): fds["pts"] += 1
    elif "inotify" in t: fds["inotify"] += 1
    elif "eventpoll" in t: fds["eventpoll"] += 1
    elif "eventfd" in t: fds["eventfd"] += 1
    elif t.startswith("pipe:"): fds["pipe"] += 1
    elif t.startswith("socket:"):
        fds["socket"] += 1
        sock_inodes[t[8:-1]] = fd
    elif t.startswith("/"): fds["file"] += 1
    else: fds["other"] += 1

TCP_STATE = {"01": "ESTABLISHED", "02": "SYN_SENT", "06": "TIME_WAIT", "07": "CLOSE", "08": "CLOSE_WAIT", "0A": "LISTEN", "04": "FIN_WAIT1", "05": "FIN_WAIT2", "09": "LAST_ACK"}


def addr(hexaddr):
    ip, port = hexaddr.split(":")
    port = int(port, 16)
    if len(ip) == 8:
        b = bytes.fromhex(ip)[::-1]
        return ".".join(str(x) for x in b), port
    return "v6:" + ip[-8:], port


socks = collections.Counter()
seen = set()
for proto in ["tcp", "tcp6", "udp", "udp6"]:
    try:
        lines = open(f"/proc/net/{proto}").read().splitlines()[1:]
    except OSError:
        continue
    for line in lines:
        f = line.split()
        if f[9] not in sock_inodes: continue
        seen.add(f[9])
        (lip, lport), (rip, rport) = addr(f[1]), addr(f[2])
        state = TCP_STATE.get(f[3], f[3]) if proto.startswith("tcp") else "udp"
        if state == "LISTEN": peer = f"listen:{lport}"
        elif lport == sport: peer = "inbound-client"
        elif rport == 4999: peer = "stub-provider"
        elif rip.startswith("104.16.") or rip.startswith("104.17."): peer = "npm-registry"
        elif rip.startswith("127.") or rip.startswith("v6:0100007F"): peer = f"loopback:{rport}"
        else: peer = f"{rip}:{rport}"
        socks[f"{proto}|{state}|{peer}"] += 1
unix = {}
for line in open("/proc/net/unix").read().splitlines()[1:]:
    f = line.split()
    if f[6] in sock_inodes: unix[f[6]] = f[7] if len(f) > 7 else ""
# unix peers via lsof +E (endpoint info)
peers = {}
try:
    out = subprocess.run(["lsof", "-nP", "-U", "+E", "-a", "-p", pid], capture_output=True, text=True, timeout=20).stdout
    for line in out.splitlines()[1:]:
        m = re.search(r"\s(\d+)\s+type=STREAM.*?->INO=(\d+) (\d+),([^,\s]+)", line)
        if not m: continue
        dev_ino = line.split()[7] if len(line.split()) > 7 else ""
        peers[m.group(1)] = f"{m.group(4)}({m.group(3)})"
except Exception:
    pass
for ino, path in unix.items():
    seen.add(ino)
    socks[f"unix|{path or 'anon'}|{peers.get(ino, '?')}"] += 1
socks["unclassified(netlink/other)"] = len(set(sock_inodes) - seen)

kids = collections.Counter(); kids_rss = collections.Counter()
for t in os.listdir("/proc"):
    if not t.isdigit(): continue
    try:
        s = kv(f"/proc/{t}/status")
        if s.get("PPid") != pid: continue
        name = s.get("Name", "?")
        kids[name] += 1
        kids_rss[name] += kb(s.get("VmRSS", "0 kB"))
    except OSError:
        pass

print(json.dumps({
    "t": time.strftime("%H:%M:%S"), "ts": time.time(), "label": label,
    "rss_kb": kb(st["VmRSS"]), "hwm_kb": kb(st["VmHWM"]), "anon_kb": kb(roll["Anonymous"]),
    "threads": int(st["Threads"]), "fds": dict(fds), "sockets": dict(socks),
    "children": dict(kids), "children_rss_kb": dict(kids_rss),
}))
