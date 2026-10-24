import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

FILE = Path(__file__).resolve().parents[1] / 'deploy' / 'oracle' / 'connect-account.py'
spec = importlib.util.spec_from_file_location('oci_access', FILE)
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class AccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        config = Path(self.temp.name) / 'config'
        config.write_text('[selected]\ntenancy=ocid1.tenancy.oc1..fixture\nregion=eu-frankfurt-1\nuser=ocid1.user.oc1..fixture\npass_phrase=never-print-this-fixture\n')
        self.env = patch.dict(os.environ, {'OCI_CLI_CONFIG_FILE':str(config),'OCI_CLI_PROFILE':'selected','OCI_CS_USER_OCID':'ocid1.user.oc1..fixture'})
        self.env.start()
        self.der = b'test public key fixture only' * 16
        self.encoded = base64.b64encode(self.der).decode()
        digest = hashlib.md5(self.der,usedforsecurity=False).hexdigest()
        self.fingerprint = ':'.join(digest[i:i+2] for i in range(0,len(digest),2))

    def tearDown(self):
        self.env.stop();self.temp.cleanup()

    def responses(self,keys):
        def run(command,**options):
            operation = tuple(command[5:9])
            if operation[:3] == ('iam','region-subscription','list'):
                data=[{'is-home-region':True,'region-name':'eu-frankfurt-1'}]
            elif operation == ('iam','user','api-key','list'):
                data=keys
            elif operation == ('iam','user','api-key','upload'):
                data={'fingerprint':self.fingerprint}
                self.assertEqual(command[command.index('--user-id')+1],'ocid1.user.oc1..fixture')
                self.assertIn('BEGIN PUBLIC KEY',command[command.index('--key')+1])
            else:
                raise AssertionError('Unexpected operation: '+repr(command))
            return subprocess.CompletedProcess(command,0,json.dumps({'data':data}),'')
        return run

    def test_grants_only_explicit_public_key_and_returns_no_credentials(self):
        with patch.object(access.shutil,'which',return_value='/bin/oci'),patch.object(access.subprocess,'run',side_effect=self.responses([{'fingerprint':'other-existing-key'}])) as run:
            result=access.connect(self.encoded)
        self.assertEqual(run.call_count,3)
        self.assertEqual(result['fingerprint'],self.fingerprint)
        self.assertNotIn('never-print-this-fixture',json.dumps(result))
        self.assertFalse(result['already_registered'])
        self.assertIn(self.fingerprint,result['revoke_command'])

    def test_repeated_key_is_reused_and_full_key_list_never_deletes_existing_keys(self):
        with patch.object(access.shutil,'which',return_value='/bin/oci'),patch.object(access.subprocess,'run',side_effect=self.responses([{'fingerprint':self.fingerprint}])) as run:
            self.assertTrue(access.connect(self.encoded)['already_registered'])
        self.assertEqual(run.call_count,2)
        with patch.object(access.shutil,'which',return_value='/bin/oci'),patch.object(access.subprocess,'run',side_effect=self.responses([{'fingerprint':str(i)} for i in range(3)])) as run:
            with self.assertRaises(access.AccessError):access.connect(self.encoded)
        self.assertEqual(run.call_count,2)

    def test_cli_cannot_grant_access_without_explicit_flag(self):
        with patch.object(sys,'argv',['connect-account.py','--public-key-der',self.encoded]),patch.object(access,'connect') as connect,contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):access.main()
        connect.assert_not_called()

    def test_mismatched_user_does_not_receive_a_key(self):
        with patch.dict(os.environ,{'OCI_CS_USER_OCID':'ocid1.user.oc1..other'}),patch.object(access.shutil,'which',return_value='/bin/oci'),patch.object(access.subprocess,'run') as run:
            with self.assertRaises(access.AccessError):access.connect(self.encoded)
        run.assert_not_called()


if __name__=='__main__':unittest.main()
