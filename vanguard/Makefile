.PHONY: all install format lint test test-ci fix upgrade check-upgrade

all: install format lint test

install:
	npm install

format:
	npm run format

lint:
	npm run lint

test:
	npm test

test-ci:
	npm test

fix:
	npx eslint --fix . && npm run format

upgrade:
	npm update && npm install

check-upgrade:
	npm outdated || true
