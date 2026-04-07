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
Currently, deployment is handled via GitHub Actions when tags are pushed.
(TODO: Add details about deployment)
