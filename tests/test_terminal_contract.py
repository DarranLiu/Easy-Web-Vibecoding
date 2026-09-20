from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
MAIN_PY = (ROOT / "backend" / "main.py").read_text()


class TerminalContractTests(unittest.TestCase):
    def test_tmux_attach_forces_capable_term(self):
        self.assertIn('os.environ["TERM"] = "xterm-256color"', MAIN_PY)
        self.assertNotIn('os.environ.setdefault("TERM"', MAIN_PY)


if __name__ == "__main__":
    unittest.main()
