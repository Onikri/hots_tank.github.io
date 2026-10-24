# Oracle deployment

The automatic service replaces the manual Colab launch. The site sends a small
job; the VM parses public sources, downloads/remuxes one episode at a time,
encrypts it and uploads to the owner's Drive. Closing the website does not stop
the accepted task. No media is transferred through the owner's device or a Worker.

## Free account access

Use Oracle's own Console and Cloud Shell. Paid browser automation and third-party
wallets are not part of this deployment. Cloud Shell is free within its tenancy
monthly limits and its OCI CLI is already authenticated:
https://docs.oracle.com/en-us/iaas/Content/API/Concepts/devcloudshellintro.htm

Run `python3 check-account.py` in Cloud Shell before provisioning. It uses the
existing active CLI profile, identifies the home region and lists indexed
instances and volumes across accessible compartments. It does not create API
keys, resources, billing settings or IAM policies, and never prints credentials.
The output can be shared to select the VM configuration. Resource Search is an
inventory snapshot; free eligibility and the account's current allowances must
still be checked before creating a VM. A failed query stops the check rather
than treating an unknown allocation as zero.

If the owner wants the assistant to perform the deployment directly without a
paid browser, `connect-account.py` can register an assistant-generated **public**
RSA API key. This is a separate access-granting operation: it requires both
`--public-key-der <base64-DER>` and the explicit `--grant-temporary-access` flag.
Run it only from the owner's authenticated Cloud Shell after reviewing it. The
matching private key stays in the assistant's protected execution workspace and
is never published or passed through chat. The returned tenancy/user/region/
fingerprint are public selectors, not credentials. Existing keys are preserved;
a repeated call reuses only the same fingerprint. No VM, storage, IAM policy or
paid subscription is created by the helper. The key grants the signed-in user's
OCI permissions and must be revoked after setup; the output includes the exact
revocation command. OCI API keys do not expire automatically.

## Cost and account checks before applying Terraform

Do not change the account to Pay As You Go as part of deployment. The template
does not upgrade the account and does not contain billing operations.

Check **the actual tenancy**, its home region, existing instances, boot/block
volumes and Always Free eligibility before applying. This template requests one
A1 ARM VM, 2 OCPUs, 12 GB RAM and a 50 GB boot volume. Existing resources count
toward the same allowance. The current Oracle documentation checked on
2026-10-24 specifies 1,500 OCPU hours and 9,000 GB hours/month for A1, equivalent
to 2 OCPUs/12 GB, and 200 GB total boot/block storage. Some older tutorials quote
4 OCPUs/24 GB; do not use those numbers without checking the account.

An Oracle **budget is an alert, not a hard spending cap**. Budget alerts are
evaluated periodically; a $1 budget does not stop resource creation or billing.
Do not treat PAYG as a documented permanent exemption from idle reclamation.
Do not generate artificial CPU/memory/network load to avoid the idle policy.
The encrypted media and completed-episode recovery manifests remain in Drive;
the application can resume after redeployment. Back up the VM's private data
volume through the owner's secure backup process if the queue and offline
credentials must also survive loss of its boot volume.

Official sources:
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm
- https://www.oracle.com/cloud/free/faq/

## Provision and finish private configuration

Use `main.tf` and `cloud-init.yaml` with Oracle Resource Manager or Terraform.
Review the plan in the verified account before applying. Supply the tenancy,
compartment, home region and **public** SSH key. Narrow `ssh_source_cidr` to the
administrative connection when its address is known. No private SSH key or
Google secret belongs in Terraform variables, state or cloud-init.

The bootstrap installs Docker and sparsely checks out only `media-vault`, avoiding
the unrelated, large archive of the existing Tank guide. It creates the private
data directory and an empty private `.env`; it does not start an unauthenticated
import service or invent Google credentials.

On the VM set `deploy/oracle/.env`: the HTTPS hostname, existing public Google
web Client ID and its Client Secret. The secret is used only by the VM to finish
Google's offline authorization flow; it never goes into GitHub or the website.
Point a domain at the public IP, or use `<IP>.sslip.io`. Caddy obtains an HTTPS
certificate automatically. Open inbound 80/443 in OCI and the OS firewall; 7860
remains inside the Docker network. Run `sudo bash start.sh` from this directory.

Add `https://<hostname>/oauth/callback` as an authorized redirect URI for the
same Google web OAuth client; retain `https://onikri.github.io` as its JavaScript
origin. The Drive API must be enabled. If Google's OAuth consent app is External
and remains in Testing, Drive refresh tokens normally expire after seven days;
unattended long-term operation requires configuring the consent app accordingly.
Users still may revoke access at any time.

Set the public `importServerUrl` in `config.js` after the health check succeeds.
The website also allows the owner to set this address once in import settings.
Sign in as `roma.shevchenko2020@gmail.com`, unlock the existing library and grant
the VM background Drive access once. Subsequent imports start from the website
without notebooks, copying JSON jobs or entering the phrase on a server.

Tasks and refresh credentials are encrypted at rest with the VM's private
`data/service.key`. A task receives only the derived 32-byte vault key over HTTPS,
not the phrase. Successful/cancelled tasks discard that task key. One worker
serializes catalog writes; avoid editing the same catalog from another device
during an import. User cancellation takes effect between files.

To update application code, pull the sparse checkout and run `start.sh` again.
The private data volume is retained; tasks interrupted by a restart are queued
again and skip completed Drive files.
