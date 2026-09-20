"""CSE Log & Order — a network connection is an action, judged the same way."""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pytest

from agentgate_engine.cse.loader import Connection, load_connections, sniff_format
from agentgate_engine.cse.mapper import _is_internal, connection_to_action, infer_tool
from agentgate_engine.cse.report import triage

NOW = dt.datetime.now(dt.timezone.utc)


def conn(**kw) -> Connection:
    base = dict(ts=NOW, src_ip="10.0.1.5", dst_ip="203.0.113.9", dst_port=443,
                bytes_out=1000, bytes_in=5000, proto="tcp")
    return Connection(**{**base, **kw})


class TestFormatSniffing:
    def test_recognises_the_three_formats(self):
        assert sniff_format("#separator \\x09\n#fields\tts") == "zeek"
        assert sniff_format('{"ts": 1}') == "jsonl"
        assert sniff_format("ts,src_ip,dst_ip\n1,2,3") == "csv"


class TestLoader:
    def test_reads_zeek_and_normalises_the_columns(self, tmp_path: Path):
        log = tmp_path / "conn.log"
        log.write_text(
            "#separator \\x09\n"
            "#fields\tts\tid.orig_h\tid.orig_p\tid.resp_h\tid.resp_p\tproto\torig_bytes\tresp_bytes\n"
            "1700000000.5\t10.0.0.1\t5000\t203.0.113.4\t443\ttcp\t1200\t8000\n"
        )
        [c] = load_connections(log)
        assert c.src_ip == "10.0.0.1" and c.dst_port == 443 and c.bytes_out == 1200

    def test_reads_csv_with_different_column_names(self, tmp_path: Path):
        log = tmp_path / "t.csv"
        log.write_text("timestamp,source_ip,dest_ip,dport,bytes_sent\n"
                       "2026-09-19T10:00:00,10.0.0.2,8.8.8.8,53,120\n")
        [c] = load_connections(log)
        assert c.src_ip == "10.0.0.2" and c.dst_port == 53 and c.bytes_out == 120

    def test_keeps_columns_it_does_not_recognise(self, tmp_path: Path):
        # Throwing away an unknown field is how a forensic tool loses the one
        # thing that mattered.
        log = tmp_path / "t.csv"
        log.write_text("ts,src_ip,dst_ip,ja3_hash\n1700000000,10.0.0.1,1.1.1.1,abc123\n")
        [c] = load_connections(log)
        assert c.extra.get("ja3_hash") == "abc123"

    def test_skips_rows_that_are_not_connections(self, tmp_path: Path):
        log = tmp_path / "t.csv"
        log.write_text("ts,note\n1700000000,just a log line\n")
        assert load_connections(log) == []


class TestInternalClassification:
    def test_documentation_ranges_count_as_external(self):
        # ipaddress.is_private says True for these; they stand in for PUBLIC
        # addresses in every sample dataset, so treating them as internal would
        # hide the exfiltration in a demo capture.
        assert _is_internal("203.0.113.9") is False
        assert _is_internal("198.51.100.7") is False
        assert _is_internal("10.0.0.1") is True
        assert _is_internal("192.168.1.1") is True

    def test_a_malformed_address_is_not_internal(self):
        assert _is_internal("45.83.103") is False
        assert _is_internal("not-an-ip") is False


class TestIntent:
    def test_names_the_action_rather_than_the_port(self):
        assert infer_tool(conn(dst_port=22)) == "remote_shell"
        assert infer_tool(conn(dst_port=53)) == "dns_query"
        assert infer_tool(conn(dst_port=4444)) == "connect_unusual_port"

    def test_a_web_request_that_uploads_50mb_is_an_upload(self):
        assert infer_tool(conn(dst_port=443, bytes_out=50_000_000)) == "file_upload"

    def test_direction_is_derived_from_both_ends(self):
        out = connection_to_action(conn(src_ip="10.0.0.1", dst_ip="203.0.113.9"))
        inn = connection_to_action(conn(src_ip="203.0.113.9", dst_ip="10.0.0.1"))
        assert out.tool_args["direction"] == "outbound"
        assert inn.tool_args["direction"] == "inbound"

    def test_the_source_host_becomes_the_agent_and_the_session(self):
        a = connection_to_action(conn(src_ip="10.0.1.44"))
        assert a.agent_id == "10.0.1.44"
        # Per-host session, so cumulative limits accumulate over that host's
        # traffic rather than over the whole capture.
        assert a.session_id == "host:10.0.1.44"


class TestTriage:
    def test_catches_beaconing_by_its_regularity(self):
        beacon = [conn(ts=NOW + dt.timedelta(seconds=60 * i), bytes_out=800, bytes_in=200)
                  for i in range(20)]
        t = triage(beacon)
        assert t.score >= 45
        assert any("beaconing" in r for r in t.reasons)

    def test_does_not_call_irregular_browsing_beaconing(self):
        import random
        random.seed(3)
        human = [conn(ts=NOW + dt.timedelta(seconds=sum(random.randint(5, 400) for _ in range(i))))
                 for i in range(20)]
        assert not any("beaconing" in r for r in triage(human).reasons)

    def test_flags_a_lopsided_upload_ratio(self):
        t = triage([conn(bytes_out=50_000_000, bytes_in=1_000)])
        assert any("ratio" in r for r in t.reasons)

    def test_flags_inbound_remote_access(self):
        t = triage([conn(src_ip="203.0.113.9", dst_ip="10.0.0.5", dst_port=3389)])
        assert t.score >= 55
        assert any("inbound remote access" in r for r in t.reasons)

    def test_ordinary_web_traffic_scores_nothing(self):
        assert triage([conn(dst_port=443, bytes_out=2_000, bytes_in=40_000)]).score == 0


class TestAnalysis:
    async def test_triage_keeps_the_judge_off_almost_all_traffic(self, harness):
        harness()
        from agentgate_engine.cse.report import analyse

        noise = [conn(src_ip=f"10.0.1.{i % 50}", dst_ip=f"104.18.0.{i % 100}",
                      bytes_out=2_000, bytes_in=40_000) for i in range(400)]
        planted = [conn(src_ip="10.0.1.99", dst_ip="203.0.113.66", dst_port=4444,
                        ts=NOW + dt.timedelta(seconds=60 * i), bytes_out=800, bytes_in=200)
                   for i in range(20)]

        report = await analyse(noise + planted, judge_budget=5)
        assert report.total_connections == 420
        assert report.judged <= 5, "the judge must not see ordinary traffic"
        assert any(f.host == "10.0.1.99" for f in report.findings), "the beacon must be found"

    async def test_an_empty_log_reports_nothing_rather_than_failing(self, harness):
        harness()
        from agentgate_engine.cse.report import analyse

        report = await analyse([])
        assert report.total_connections == 0 and report.findings == []
