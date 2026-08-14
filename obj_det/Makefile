SHELL := /bin/bash

NPM ?= npm
PYTHON ?= python3
MODEL_VENV ?= .model-venv
MODEL_PYTHON := $(MODEL_VENV)/bin/python

.DEFAULT_GOAL := help

.PHONY: help install dev build test model-tools export-model

help: ## Show the available commands
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install frontend dependencies
	$(NPM) --prefix web install

dev: ## Start the browser-only development server
	$(NPM) --prefix web run dev

build: ## Build the static application
	$(NPM) --prefix web run build

test: ## Run frontend tests
	$(NPM) --prefix web test

model-tools: ## Install optional release-time model export tools
	@test -x "$(MODEL_PYTHON)" || $(PYTHON) -m venv "$(MODEL_VENV)"
	$(MODEL_PYTHON) -m pip install -r tools/requirements-model.txt

export-model: model-tools ## Rebuild the checked-in ONNX browser model
	MPLCONFIGDIR=/tmp/titanom-matplotlib $(MODEL_PYTHON) tools/export_model.py
