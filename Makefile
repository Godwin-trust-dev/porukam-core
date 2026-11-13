.PHONY: up migrate run test lint fmt

up migrate run test lint fmt:
	$(MAKE) -C backend $@
