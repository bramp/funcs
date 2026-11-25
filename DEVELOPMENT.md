# Development Guide

This guide describes how to develop, test, and release this project.

## Requirements
* Node.js (>= 20)
* npm (>= 10)

## Build and Test
Every project has a standard `Makefile` that handles the core workflow.

```bash
# Install dependencies
make install

# Format code
make format

# Run linting
make lint

# Run tests
make test
```

## Repository Structure
This is a monorepo containing multiple Google Cloud Functions. Each function is located in its own directory.

* `vanguard/` - Fetches Vanguard fund data.

## Continuous Integration
GitHub Actions are configured to run tests on every push and pull request.
See `.github/workflows/test.yml`.

## Deployment
GitHub Actions deploys Vanguard after tests pass on pushes to `main` that change
function code or `.github/workflows/deploy.yml`. Changes limited to the function's
tests, README, or Makefile do not trigger deployment.

The function runs on Node.js 24 in `us-central1`, with 256 MiB of memory,
one request per instance, and a maximum of two instances. The previous 128 MiB
limit caused production instances to be terminated at approximately 135-139 MiB.
Validate memory usage after deployment; a local mock benchmark does not include
all Cloud Run runtime overhead.
