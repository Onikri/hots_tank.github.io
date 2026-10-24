"""Cost preflight: unknown allocations must never be reported as an empty account."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


FILE = Path(__file__).resolve().parents[1] / "deploy" / "oracle" / "check-account.py"
spec = importlib.util.spec_from_file_location("oci_preflight", FILE)
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        config = Path(self.temporary.name) / "config"
        config.write_text("[active-region]\ntenancy=ocid1.tenancy.oc1..fixture\nregion=eu-frankfurt-1\npass_phrase=fixture-private-value\nkey_file=/must-not-be-opened/private-key\n")
        self.environment = patch.dict(os.environ, {"OCI_CLI_CONFIG_FILE": str(config), "OCI_CLI_PROFILE": "active-region"})
        self.environment.start()
        self.cli = patch.object(preflight.shutil, "which", return_value="/bin/oci")
        self.cli.start()

    def tearDown(self):
        self.cli.stop()
        self.environment.stop()
        self.temporary.cleanup()

    def fake_cli(self, command, **options):
        operation = tuple(command[5:8])
        if operation == ("iam", "region-subscription", "list"):
            data = [{"region-name": "eu-frankfurt-1", "is-home-region": True}]
        elif operation == ("iam", "availability-domain", "list"):
            data = [{"name": "fixture:EU-FRANKFURT-1-AD-1"}]
        elif operation == ("search", "resource", "structured-search"):
            data = {"items": [{"resource-type": "Instance", "identifier": "vm-id"}, {"resource-type": "BootVolume", "identifier": "boot-id"}]}
        elif operation == ("compute", "instance", "get"):
            data = {"display-name": "existing", "shape": "VM.Standard.A1.Flex", "lifecycle-state": "STOPPED", "shape-config": {"ocpus": 2, "memory-in-gbs": 12}}
        elif operation == ("bv", "boot-volume", "get"):
            data = {"display-name": "existing disk", "size-in-gbs": 100, "lifecycle-state": "AVAILABLE"}
        else:
            raise AssertionError("Unexpected OCI operation: " + repr(command))
        return subprocess.CompletedProcess(command, 0, json.dumps({"data": data}), "")

    def test_existing_stopped_instance_counts_and_only_inventory_operations_are_called(self):
        with patch.object(preflight.subprocess, "run", side_effect=self.fake_cli) as run:
            report = preflight.inventory()
        self.assertEqual(report["mode"], "READ_ONLY")
        self.assertEqual(report["existing_a1"], {"ocpus": 2, "memory_gb": 12})
        self.assertEqual(report["existing_disk_gb"], 100)
        self.assertFalse(report["fits_conservative_bounds"])
        self.assertEqual(run.call_count, 5)
        self.assertNotIn("fixture-private-value", json.dumps(report))

    def test_permission_failure_stops_instead_of_claiming_resources_are_zero(self):
        def response(command, **options):
            if "structured-search" in command:
                return subprocess.CompletedProcess(command, 1, "", 'ServiceError: {"code":"NotAuthorizedOrNotFound"} private-auth-header-fixture')
            return self.fake_cli(command, **options)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(preflight.subprocess, "run", side_effect=response),contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr):
            self.assertEqual(preflight.main(), 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("NotAuthorizedOrNotFound", stderr.getvalue())
        self.assertNotIn("private-auth-header-fixture", stderr.getvalue())

    def test_missing_named_profile_never_falls_back_to_another_identity(self):
        with patch.dict(os.environ, {"OCI_CLI_PROFILE": "missing"}),patch.object(preflight.subprocess, "run") as run:
            with self.assertRaises(preflight.CheckError):
                preflight.inventory()
        run.assert_not_called()

    def test_unknown_shape_allocation_does_not_become_zero(self):
        def response(command, **options):
            if "--instance-id" in command:
                data = {"shape": "VM.Standard.A1.Flex", "shape-config": {}, "lifecycle-state": "RUNNING"}
                return subprocess.CompletedProcess(command, 0, json.dumps({"data": data}), "")
            return self.fake_cli(command, **options)
        with patch.object(preflight.subprocess, "run", side_effect=response):
            with self.assertRaises(preflight.CheckError):
                preflight.inventory()


if __name__ == "__main__":
    unittest.main()
