# Example policies — not loaded by default

The engine loads `policies/*.md` only, so nothing in this directory is active.

These exist to show that a cumulative control is a **policy**, not code. Copy one
up a level and `POST /policies/reload`, and the limit is live — no restart, no
deploy, no change to the engine.

```bash
cp src/agentgate_engine/policies/examples/phi-access-volume.md \
   src/agentgate_engine/policies/
curl -s -X POST localhost:8000/policies/reload -H "Authorization: Bearer $AGENTGATE_API_KEY"
```

`phi-access-volume.md` counts patient-record reads for a hospital. The default
pack counts dollars for a retailer. Neither is special to the engine — both are
`Accumulate:` expressions over a `Limit:`.
