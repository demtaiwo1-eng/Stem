# STEM Google Cloud CPU Worker

This folder contains STEM's remote, open-source Demucs worker. It polls the existing STEM Render API, claims queued jobs, downloads audio through a short-lived signed URL, separates stems on CPU, and uploads results through the authenticated worker API. Render and Neon remain the application API and private job/storage layer; Google Cloud replaces only the processing machine.

## Cost and billing guardrails

- Prefer the Google Cloud Free Trial only if your account is eligible and the $300 credit is still available.
- Google currently describes the Free Trial as $300 of credit for 90 days. It does not automatically bill you during the trial. If you do not manually upgrade to a paid billing account, the trial closes and its workloads stop when the credit is exhausted or the 90 days expire.
- **Do not click Upgrade, activate a paid billing account, or enable Pay As You Go.**
- The Compute Engine Always Free e2-micro VM is not suitable for reliable Demucs processing; it has too little memory.
- Use a temporary `e2-standard-2` (2 vCPU, 8 GB RAM) only while covered by trial credit. It is a CPU-only test/low-volume worker, not a permanent free server. Costs consume the trial credit.
- Use a 30 GB standard boot disk and do not add GPUs, extra disks, static external IP reservations, load balancers, Cloud NAT, or other optional paid services.
- Do not create the VM if the console shows that the Free Trial is unavailable, billing is already paid, or any charge would be made outside trial credit. Stop and ask before proceeding.
- Set a billing budget alert if available, but remember alerts are notifications, not spending caps.
- When finished testing, stop or delete the VM. Deleting the VM is safest if the project is being handed over; preserve no customer data on the VM because job data lives in Neon private storage.

Official terms: https://cloud.google.com/signup-faqs and https://cloud.google.com/free/docs/free-cloud-features

## Required Render environment

The existing Render API must have the following environment variable set privately:

- `STEM_WORKER_TOKEN`: a random secret of at least 32 characters.

Keep the existing Render API, Neon connection and private object-storage credentials unchanged. Do not expose the worker token in frontend JavaScript or commit it to GitHub. The worker token must be identical in Render and the VM's instance metadata.

## Create the Compute Engine VM

1. Open https://console.cloud.google.com/ and select or create a project.
2. Confirm the Billing page says **Free Trial** and shows remaining credit. Do not upgrade to a paid billing account.
3. Enable the Compute Engine API only if the console allows it within the Free Trial.
4. Create one VM in a region/zone available to your account:
   - Name: `stem-cpu-worker`
   - Machine type: `e2-standard-2` (2 vCPU, 8 GB RAM)
   - Boot disk: Ubuntu 24.04 LTS, standard persistent disk, 30 GB
   - Firewall: do not allow HTTP or HTTPS ingress; the worker makes outbound HTTPS requests only
   - No GPU, no extra disk, no load balancer, no NAT gateway
5. Under **Advanced options → Management → Automation → Startup script**, paste the complete contents of `google-compute-startup.sh`.
6. Under **Advanced options → Security → Metadata** (or the VM's custom metadata section), add:
   - Key: `stem-worker-token`
   - Value: the same random secret set privately as `STEM_WORKER_TOKEN` in Render.
   Do not put the secret in GitHub, a public issue, or this chat.
7. Create the VM only after confirming the console still identifies the account as Free Trial and no paid-account upgrade is being requested.

The startup script installs Docker, downloads the public STEM repository, builds the worker image and starts it with 2 CPUs and a 7 GB memory cap. It reads the token from instance metadata and writes it to a root-only environment file.

## Verify the worker

On the VM's SSH terminal, run:

```sh
sudo docker ps
sudo docker logs --tail 100 stem-google-cloud-worker
```

Then check the STEM API health endpoint:

https://stem-api-o0ij.onrender.com/health

A successful connection requires `workerConfigured: true` and `workerOnline: true`. After that, upload a short audio file through the STEM website and confirm that the job reaches `completed` and the stems can be played/downloaded.

## Worker environment

- `STEM_API_BASE=https://stem-api-o0ij.onrender.com`
- `STEM_WORKER_TOKEN`: same secret as Render
- `STEM_MODEL=htdemucs_6s`
- `STEM_CPU_THREADS=2`

The worker never receives Neon credentials. Audio moves between the worker and private storage using short-lived signed URLs.

## Limitations

CPU separation is slower than GPU processing. The e2-standard-2 machine is intended for initial integration and low-volume testing. Trial credit is temporary; once it ends, the worker stops unless someone deliberately upgrades to paid billing. Do not upgrade just to keep STEM running. Existing customer job history and files remain in Neon when the worker is stopped.
