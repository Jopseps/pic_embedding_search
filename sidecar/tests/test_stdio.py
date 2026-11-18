import io

from picsearch.server import _harden_stdio, _TolerantStream


class _Dead(io.StringIO):
    """A stderr whose reader has gone away."""

    def write(self, text):
        raise OSError(22, "Invalid argument")

    def flush(self):
        raise OSError(22, "Invalid argument")


def test_a_dead_stderr_never_raises():
    stream = _TolerantStream(_Dead())
    assert stream.write("abc") == 3
    stream.flush()


def test_a_live_stderr_passes_through():
    inner = io.StringIO()
    stream = _TolerantStream(inner)
    stream.write("hello")
    stream.flush()
    assert inner.getvalue() == "hello"
    assert stream.getvalue() == "hello"  # attribute access reaches the real stream


def test_harden_stdio_survives_streams_that_cannot_be_reconfigured(monkeypatch):
    import sys

    monkeypatch.setattr(sys, "stdout", io.StringIO())
    monkeypatch.setattr(sys, "stderr", io.StringIO())
    _harden_stdio()
    sys.stderr.write("x")
    sys.stderr.flush()
