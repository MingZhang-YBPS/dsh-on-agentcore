#!/usr/bin/env python3
"""拉取两个触发器的 CloudWatch 日志，按用例时间窗与 clientMetadata.case 对齐，
输出 results/trigger-invocations.jsonl 与 results/summary.md。"""
import json
import os
import subprocess
import time

SPIKE_DIR = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(SPIKE_DIR, "results")
FNS = {"pre": "dsh-poc-spike-preauth", "post": "dsh-poc-spike-postauth"}


def load_state():
    st = {}
    with open(os.path.join(SPIKE_DIR, ".state", "state.env"), encoding="utf-8") as f:
        for line in f:
            k, _, v = line.strip().partition("=")
            st[k] = v.strip("'\"")
    return st


def fetch(fn, region, start_ms):
    events, token = [], None
    while True:
        args = ["aws", "logs", "filter-log-events", "--region", region,
                "--log-group-name", f"/aws/lambda/{fn}", "--start-time", str(start_ms),
                "--filter-pattern", "DSH_SPIKE_TRIGGER", "--output", "json"]
        if token:
            args += ["--next-token", token]
        p = subprocess.run(args, capture_output=True, text=True)
        if p.returncode != 0:
            if "ResourceNotFoundException" in p.stderr:
                return []
            raise RuntimeError(p.stderr)
        out = json.loads(p.stdout)
        for e in out.get("events", []):
            msg = e["message"]
            i = msg.find("{")
            try:
                events.append(json.loads(msg[i:]))
            except (ValueError, IndexError):
                continue
        token = out.get("nextToken")
        if not token:
            return events


def main():
    st = load_state()
    region = st["REGION"]
    cases_file = os.environ.get("CASES_FILE", "cases.jsonl")
    cases = [json.loads(l) for l in open(os.path.join(RESULTS, cases_file), encoding="utf-8")]
    start = min(c["startMs"] for c in cases) - 5000
    time.sleep(int(os.environ.get("LOG_WAIT_SECONDS", "15")))  # 等待日志投递
    inv = []
    for kind, fn in FNS.items():
        for e in fetch(fn, region, start):
            e["kind"] = kind
            inv.append(e)
    inv.sort(key=lambda e: e["ts"])
    suffix = cases_file.removeprefix("cases").removesuffix(".jsonl")
    with open(os.path.join(RESULTS, f"trigger-invocations{suffix}.jsonl"), "w", encoding="utf-8") as f:
        for e in inv:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    def match(c, kind):
        hits = []
        for e in inv:
            if e["kind"] != kind:
                continue
            cm = (e.get("clientMetadata") or {}).get("case")
            if cm == c["case"] or (cm is None and c["startMs"] - 200 <= e["ts"] <= c["endMs"] + 200):
                hits.append(e)
        return hits

    lines = ["| 用例 | 场景 | 流程 | 结果 | 错误码 | 错误消息 | PreAuth 调用 | PostAuth 调用 | PreAuth userNotFound |",
             "|---|---|---|---|---|---|---|---|---|"]
    for c in cases:
        pre, post = match(c, "pre"), match(c, "post")
        unf = ",".join(str(e.get("userNotFound")) for e in pre) or "-"
        flow = "USER_PASSWORD" if c["flow"] == "USER_PASSWORD_AUTH" else "ADMIN_USER_PASSWORD"
        lines.append(f"| {c['case']} | {c['desc']} | {flow} | {c['outcome']} | {c.get('errorCode') or ''} | "
                     f"{(c.get('errorMessage') or '').replace('|', '/')} | {len(pre)} | {len(post)} | {unf} |")
    md = "\n".join(lines) + "\n"
    with open(os.path.join(RESULTS, f"summary{suffix}.md"), "w", encoding="utf-8") as f:
        f.write(md)
    print(md)


if __name__ == "__main__":
    main()
