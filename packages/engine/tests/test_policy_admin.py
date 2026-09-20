"""Runtime policy management: an enterprise's policy set is theirs, not ours."""

from __future__ import annotations

import pytest

from agentgate_engine import evaluate_detailed, load_policies, seed_pack
from agentgate_engine.policy_admin import (
    MemoryPolicyBackend,
    PolicyValidationError,
    configure_policy_backend,
    delete_policy,
    reload_policies,
    set_enabled,
    slugify,
    upsert_policy,
    validate_markdown,
)

from .conftest import make_action

CRYPTO = """# Crypto Wallet Transfers
Agents may not initiate transfers to cryptocurrency wallet addresses. Crypto
transfers are irreversible and are a preferred exfiltration channel for a
compromised agent. Any transfer to a wallet address needs human approval.
Severity: critical
Applies to: financial
"""


@pytest.fixture(autouse=True)
def fresh_backend():
    configure_policy_backend(MemoryPolicyBackend())
    yield
    configure_policy_backend(MemoryPolicyBackend())


class TestValidation:
    def test_accepts_a_well_formed_policy(self):
        meta = validate_markdown(CRYPTO)
        assert meta["name"] == "Crypto Wallet Transfers"
        assert meta["declares_limit"] is False

    def test_rejects_a_policy_with_no_title(self):
        with pytest.raises(PolicyValidationError, match="Title"):
            validate_markdown("no heading here\nApplies to: financial")

    def test_rejects_a_policy_with_no_applies_to(self):
        # Without it the policy is retrieved for nothing and silently does
        # nothing, while the operator believes a control is on.
        with pytest.raises(PolicyValidationError, match="Applies to"):
            validate_markdown("# Title\nA body long enough to be meaningful here.")

    def test_rejects_a_title_with_no_body(self):
        with pytest.raises(PolicyValidationError, match="body"):
            validate_markdown("# Just A Title\nApplies to: financial")

    def test_rejects_a_malformed_cumulative_limit(self):
        with pytest.raises(PolicyValidationError, match="not supported"):
            validate_markdown(
                "# Bad Limit\nA body long enough to pass the length check.\n"
                "Applies to: financial\nAccumulate: median(toolArgs.amount)\nLimit: 10\n"
            )

    def test_slugify_produces_a_usable_id(self):
        assert slugify("Crypto Wallet Transfers") == "crypto-wallet-transfers"
        assert slugify("PII / PHI  handling!") == "pii-phi-handling"


class TestLifecycle:
    async def test_a_new_policy_is_live_for_the_very_next_evaluation(self, harness):
        harness()
        before = len(load_policies())

        result = await upsert_policy(CRYPTO)
        assert result["id"] == "crypto-wallet-transfers"
        assert len(load_policies()) == before + 1

        names = {p.name for p in load_policies()}
        assert "Crypto Wallet Transfers" in names, "no restart should be required"

    async def test_disabling_removes_it_from_the_corpus(self, harness):
        harness()
        await upsert_policy(CRYPTO)
        assert any(p.id == "crypto-wallet-transfers" for p in load_policies())

        assert await set_enabled("crypto-wallet-transfers", False)
        assert not any(p.id == "crypto-wallet-transfers" for p in load_policies())

        assert await set_enabled("crypto-wallet-transfers", True)
        assert any(p.id == "crypto-wallet-transfers" for p in load_policies())

    async def test_deleting_returns_a_shipped_default_to_its_seed_version(self, harness):
        harness()
        override = seed_pack()["pii-protection"].replace(
            "# PII Protection", "# PII Protection"
        ) + "\nAn extra clause added by the customer.\n"
        await upsert_policy(override, policy_id="pii-protection")
        assert "extra clause" in next(
            p.text for p in load_policies() if p.id == "pii-protection"
        )

        await delete_policy("pii-protection")
        assert "extra clause" not in next(
            p.text for p in load_policies() if p.id == "pii-protection"
        ), "the shipped default should come back"

    async def test_a_stored_policy_overrides_a_shipped_one_with_the_same_id(self, harness):
        harness()
        await upsert_policy(
            "# PII Protection\nCustomer's own much stricter wording goes here.\n"
            "Severity: critical\nApplies to: external_comms\n",
            policy_id="pii-protection",
        )
        text = next(p.text for p in load_policies() if p.id == "pii-protection")
        assert "much stricter" in text
        assert len([p for p in load_policies() if p.id == "pii-protection"]) == 1

    async def test_the_corpus_is_the_seed_pack_when_nothing_is_stored(self, harness):
        harness()
        assert await reload_policies() == len(seed_pack())


class TestEnforcement:
    async def test_a_runtime_policy_is_actually_enforced(self, harness):
        # The mock judge scores from the prompt, and the prompt contains the
        # retrieved policies — so if the new policy reaches the judge at all,
        # it is in the corpus and retrievable.
        harness(judge=lambda prompt: {
            "risk_score": 90 if "Crypto Wallet Transfers" in prompt else 5,
            "reasoning": "mock",
            "violated_policy": "Crypto Wallet Transfers"
                               if "Crypto Wallet Transfers" in prompt else "",
        })
        await upsert_policy(CRYPTO)

        d = await evaluate_detailed(
            make_action("transfer_funds", {"to": "bc1qxy2kgdy", "amount": 250}, "crypto")
        )
        assert d.result.decision == "block"
        assert d.result.violated_policy == "Crypto Wallet Transfers"
