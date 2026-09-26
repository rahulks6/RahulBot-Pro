from __future__ import annotations

from ais_worker.diagnostics import parse_smi_csv


def test_parses_a_desktop_gpu() -> None:
    gpus = parse_smi_csv("0, NVIDIA GeForce RTX 4070, 12282, 1034, 11028, 566.14, 7, 41\n")
    assert gpus == [
        {
            "index": 0,
            "name": "NVIDIA GeForce RTX 4070",
            "vram_total_mb": 12282,
            "vram_used_mb": 1034,
            "vram_free_mb": 11028,
            "driver": "566.14",
            "utilization_pct": 7,
            "temperature_c": 41,
        }
    ]


def test_not_available_values_do_not_crash() -> None:
    # Laptop GPUs often report [N/A] for utilization and temperature.
    gpus = parse_smi_csv("0, NVIDIA GeForce RTX 3050 Laptop GPU, 4096, 5, [N/A], 551.23, [N/A], [Not Supported]\n")
    assert gpus[0]["utilization_pct"] is None
    assert gpus[0]["temperature_c"] is None
    assert gpus[0]["vram_free_mb"] == 4091  # derived from total - used


def test_several_gpus_and_junk_lines() -> None:
    out = "0, A, 24576, 0, 24576, 560, 0, 30\ngarbage\n1, B, 8192, 100, 8092, 560, 50, 60\n"
    assert [g["name"] for g in parse_smi_csv(out)] == ["A", "B"]
    assert parse_smi_csv("") == []
