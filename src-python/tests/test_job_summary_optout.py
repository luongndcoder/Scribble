"""Tests for the upload "generate report" opt-in/opt-out contract.

Feature: the upload form lets the user choose whether to auto-generate the
AI minutes. When opted out, the pipeline must skip summarize entirely and
finish as soon as the transcript is saved — the user is never forced to wait.

Contract:
    JobRegistry.create(meeting_id, generate_summary: bool = True)
        -> JobState.generate_summary mirrors the flag (default True)
    JobState.to_dict() exposes "generate_summary" for the frontend.
"""

from services.job_registry import JobRegistry


def test_create_defaults_to_generate_summary_true():
    reg = JobRegistry()
    job = reg.create(meeting_id=1)
    assert job.generate_summary is True
    assert job.to_dict()["generate_summary"] is True


def test_create_honors_opt_out():
    reg = JobRegistry()
    job = reg.create(meeting_id=2, generate_summary=False)
    assert job.generate_summary is False
    assert job.to_dict()["generate_summary"] is False


def test_create_honors_explicit_opt_in():
    reg = JobRegistry()
    job = reg.create(meeting_id=3, generate_summary=True)
    assert job.generate_summary is True
