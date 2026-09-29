host := "hotwire.local"

# Upload the control page to FluidNC's sd; open http://{{host}}/sd/hotwire.html
deploy:
	curl -fsS -T web/index.html http://{{host}}/sd/hotwire.html
	@echo "http://{{host}}/sd/hotwire.html"
