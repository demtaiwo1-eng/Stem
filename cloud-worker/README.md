# STEM Oracle Always Free CPU Worker

This folder contains the remote Demucs worker for STEM. It polls the STEM API, claims one queued job, downloads its input through a short-lived private-storage URL, runs open-source Demucs on CPU, and uploads the result archive through an authenticated API endpoint.

## Strict free-tier policy

- Target only an Oracle Cloud Infrastructure **Always Free eligible** Ampere A1 VM in the tenancy's home region.
- Stay within **2 OCPUs and 12 GB RAM total** across all A1 instances.
- Use an Always Free eligible Ubuntu image and the VM's included boot volume.
- Do not create paid shapes, GPU instances, paid block volumes, paid load balancers, NAT gateways, or other billable services.
- Do not upgrade the tenancy to Pay As You Go.
- If the Console labels a requested resource as paid, requests an upgrade, or shows a charge, stop. Do not continue.
- Oracle may reclaim an Always Free VM that remains idle under its published utilization thresholds. This worker is therefore best-effort, not an SLA-backed service.

Oracle's current Always Free resource limits are documented at:
https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Environment

Set these variables on the Oracle VM/container:

- `STEM_API_BASE`: `https://stem-api-o0ij.onrender.com`
- `STEM_WORKER_TOKEN`: the same high-entropy secret configured as a Render environment variable
- `STEM_MODEL`: `htdemucs_6s` (six stems; CPU processing can be slow)
- `STEM_CPU_THREADS`: `2`

Never commit the worker token or put it in frontend JavaScript.

## Run

Build for ARM64 on the Oracle A1 VM:

```sh
docker build -t stem-oracle-worker .
docker run -d --restart unless-stopped --name stem-oracle-worker \
  --cpus=2 --memory=10g \
  -e STEM_API_BASE -e STEM_WORKER_TOKEN \
  -e STEM_MODEL=htdemucs_6s \
  stem-oracle-worker
```

The container is constrained below the VM's 12 GB RAM allocation to leave room for the operating system. Do not add other compute workloads to the VM.

The worker supports one audio upload or a ZIP containing up to 20 supported tracks, subject to a 1 GiB unpacked ZIP limit. CPU jobs can take a long time. It does not use GPU services or send audio to a third-party processing API.
