#!/usr/bin/env python3
"""Spike 01 测试用例执行器（仅依赖 Python 标准库 + aws CLI）。

- 口令在运行时随机生成，只保存在进程内存中，不写文件、不打印。
- 成功响应只记录「是否拿到 AuthenticationResult」与 ExpiresIn，不记录任何令牌。
- 输出 results/cases.jsonl：每个用例一行，含开始/结束时间戳，供 collect-logs.py 与触发器日志对齐。
"""
import json
import os
import secrets
import string
import subprocess
import sys
import time

SPIKE_DIR = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(SPIKE_DIR, "results")


def load_state():
    state = {}
    with open(os.path.join(SPIKE_DIR, ".state", "state.env"), encoding="utf-8") as f:
        for line in f:
            k, _, v = line.strip().partition("=")
            state[k] = v.strip("'\"")
    return state


def gen_password():
    # 满足 Cognito 默认口令策略：大写、小写、数字、符号，长度 20
    body = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16))
    return "Aa1!" + body


def aws(args, check=True):
    p = subprocess.run(["aws", *args, "--output", "json"], capture_output=True, text=True)
    if check and p.returncode != 0:
        # 不回显参数（可能包含口令），只输出错误
        raise RuntimeError(f"aws {args[0]} {args[1]} failed: {p.stderr.strip()}")
    return p


def parse_error(stderr):
    # 形如: An error occurred (NotAuthorizedException) when calling the InitiateAuth operation: Incorrect username or password.
    s = stderr.strip()
    code, msg = None, s
    if "An error occurred (" in s:
        code = s.split("An error occurred (", 1)[1].split(")", 1)[0]
        msg = s.split("operation: ", 1)[1] if "operation: " in s else s
    elif "Parameter validation failed" in s or "Invalid length" in s:
        code = "CLIENT_SIDE_VALIDATION"
    return code, msg


def main():
    st = load_state()
    region, pool, client = st["REGION"], st["POOL_ID"], st["CLIENT_ID"]
    os.makedirs(RESULTS, exist_ok=True)
    common = ["--region", region]

    users = {
        "spikeuser": gen_password(),
        "lockeduser": gen_password(),
        "bruteuser": gen_password(),
        "adminflowuser": gen_password(),
    }
    for u, pw in users.items():
        aws(["cognito-idp", "admin-delete-user", "--user-pool-id", pool, "--username", u, *common], check=False)
        aws(["cognito-idp", "admin-create-user", "--user-pool-id", pool, "--username", u,
             "--message-action", "SUPPRESS", *common])
        aws(["cognito-idp", "admin-set-user-password", "--user-pool-id", pool, "--username", u,
             "--password", pw, "--permanent", *common])
    print(f"created {len(users)} test users (passwords random, in-memory only)")
    time.sleep(2)

    wrong = gen_password()  # 与所有真实口令都不同的错误口令

    def run(case, desc, flow, username, password, pause=1.5):
        if flow == "USER_PASSWORD_AUTH":
            args = ["cognito-idp", "initiate-auth", "--client-id", client,
                    "--auth-flow", "USER_PASSWORD_AUTH"]
        else:
            args = ["cognito-idp", "admin-initiate-auth", "--user-pool-id", pool, "--client-id", client,
                    "--auth-flow", "ADMIN_USER_PASSWORD_AUTH"]
        args += ["--auth-parameters", json.dumps({"USERNAME": username, "PASSWORD": password}),
                 "--client-metadata", json.dumps({"case": case}), *common]
        t0 = int(time.time() * 1000)
        p = aws(args, check=False)
        t1 = int(time.time() * 1000)
        rec = {"case": case, "desc": desc, "flow": flow,
               "username": username if len(username) <= 20 else f"<len={len(username)}>",
               "passwordLen": len(password), "startMs": t0, "endMs": t1, "cliElapsedMs": t1 - t0,
               "exitCode": p.returncode}
        if p.returncode == 0:
            out = json.loads(p.stdout or "{}")
            ar = out.get("AuthenticationResult")
            rec.update({"outcome": "SUCCESS" if ar else "CHALLENGE",
                        "expiresIn": ar.get("ExpiresIn") if ar else None,
                        "challenge": out.get("ChallengeName")})
        else:
            code, msg = parse_error(p.stderr)
            rec.update({"outcome": "ERROR", "errorCode": code, "errorMessage": msg[:300]})
        print(f"{case:>4} {rec['outcome']:<8} {rec.get('errorCode') or ''} | {rec.get('errorMessage') or ''} ({desc})")
        cases.append(rec)
        time.sleep(pause)
        return rec

    cases = []
    ok, lk, br, ad = (users[k] for k in ("spikeuser", "lockeduser", "bruteuser", "adminflowuser"))
    UPA, ADM = "USER_PASSWORD_AUTH", "ADMIN_USER_PASSWORD_AUTH"

    def burst():
        # 无间隔连续失败，观察 Cognito 内建锁定（1 秒起、逐次翻倍）的错误形态
        for i in range(1, 13):
            run(f"R{i:02d}", f"无间隔连续口令错误第 {i} 次", UPA, "bruteuser", wrong, pause=0)
        run("R13", "无间隔连续失败后立即使用正确口令", UPA, "bruteuser", br, pause=0)

    if os.environ.get("SPIKE_SUITE", "all") == "burst":
        burst()
        write(cases, "cases-burst.jsonl")
        return

    if os.environ.get("SPIKE_SUITE", "all") == "adminonly":
        # 仅允许 ADMIN_USER_PASSWORD_AUTH 的 App Client：浏览器无法绕过接入服务直接调用 InitiateAuth
        p = aws(["cognito-idp", "create-user-pool-client", "--user-pool-id", pool,
                 "--client-name", "dsh-poc-spike-adminonly-client", "--no-generate-secret",
                 "--explicit-auth-flows", "ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH",
                 "--prevent-user-existence-errors", "ENABLED", *common])
        admin_client = json.loads(p.stdout)["UserPoolClient"]["ClientId"]
        client = admin_client  # noqa: F841  run() 通过闭包读取 client
        try:
            run("A01", "仅 Admin 流程的客户端：浏览器直调 USER_PASSWORD_AUTH", UPA, "spikeuser", ok)
            run("A02", "仅 Admin 流程的客户端：接入服务 ADMIN_USER_PASSWORD_AUTH", ADM, "spikeuser", ok)
        finally:
            aws(["cognito-idp", "delete-user-pool-client", "--user-pool-id", pool,
                 "--client-id", admin_client, *common], check=False)
            print(f"deleted app client {admin_client}")
        write(cases, "cases-adminonly.jsonl")
        return

    run("C01", "正确口令", UPA, "spikeuser", ok)
    run("C02", "口令错误", UPA, "spikeuser", wrong)
    run("C03", "用户不存在", UPA, "nosuchuser", wrong)
    run("C04", "用户名为空", UPA, "", wrong)
    run("C05", "口令为空", UPA, "spikeuser", "")
    run("C06", "用户名 65 字符（不存在）", UPA, "u" * 65, wrong)
    run("C07", "用户名 129 字符", UPA, "u" * 129, wrong)
    run("C08", "口令 129 字符", UPA, "spikeuser", "P" * 129)
    run("C09", "口令 257 字符", UPA, "spikeuser", "P" * 257)
    run("C10", "PreAuth 拒绝（模拟锁定）+ 正确口令", UPA, "lockeduser", lk)
    run("C11", "PreAuth 拒绝（模拟锁定）+ 错误口令", UPA, "lockeduser", wrong)
    run("C12", "Admin 流程 正确口令", ADM, "adminflowuser", ad)
    run("C13", "Admin 流程 口令错误", ADM, "adminflowuser", wrong)
    run("C14", "Admin 流程 用户不存在", ADM, "nosuchuser2", wrong)
    for i in range(1, 8):
        run(f"B{i:02d}", f"连续口令错误第 {i} 次", UPA, "bruteuser", wrong)
    run("B08", "连续失败后立即使用正确口令", UPA, "bruteuser", br)
    print("waiting 20s ...")
    time.sleep(20)
    run("B09", "等待 20 秒后使用正确口令", UPA, "bruteuser", br)
    write(cases, "cases.jsonl")


def write(cases, name):
    path = os.path.join(RESULTS, name)
    with open(path, "w", encoding="utf-8") as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"wrote {path}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
