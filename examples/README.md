# Disposable upstreams

Examples intentionally avoid framework-specific project files. For a quick
manual test, start two HTTP listeners in separate terminals:

```sh
node -e 'require("http").createServer((q,r)=>r.end("alpha\n")).listen(18081,"127.0.0.1")'
node -e 'require("http").createServer((q,r)=>r.end("bravo\n")).listen(18082,"127.0.0.1")'
```

Register this repository twice as a harmless placeholder path:

```sh
unlocalhost add "$PWD" --slug alpha --port 18081
unlocalhost add "$PWD" --slug bravo --port 18082
unlocalhost proxy run
```

After trusting Caddy's local CA, verify in another terminal:

```sh
curl https://alpha.localhost:8443
curl https://bravo.localhost:8443
```

The expected responses are `alpha` and `bravo`. Registrations and the generated
Caddyfile are under `UNLOCALHOST_HOME`; this repository is not modified.

To model the second listener as an API belonging to `alpha` instead:

```sh
unlocalhost rm bravo
unlocalhost endpoint add alpha api --port 18082
unlocalhost url alpha --endpoint api
# https://alpha-api.localhost:8443
```

To exercise external Compose overrides against a real project, use:

```sh
unlocalhost add /absolute/project/path --slug example
```

If several declared ports are found, select the HTTP services in the prompt or
run `unlocalhost add /absolute/project/path --slug example --services web,api`.
unlocalhost allocates every host-side mapping automatically. `unlocalhost endpoint list
example` prints the selected values and URLs.

Before and after `unlocalhost up example`, `git -C /absolute/project/path status
--porcelain` should produce the same output.
