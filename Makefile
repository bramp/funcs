.PHONY: all install format lint test test-ci fix upgrade check-upgrade

SUBDIRS := vanguard

all install format lint test test-ci fix upgrade check-upgrade:
	@for dir in $(SUBDIRS); do \
		$(MAKE) -C $$dir $@; \
	done
