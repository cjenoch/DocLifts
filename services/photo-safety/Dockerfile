FROM python:3.12-slim
ENV PIP_NO_CACHE_DIR=1 HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=2 PYTHONDONTWRITEBYTECODE=1
RUN pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
RUN pip install transformers==5.18.0 Pillow==13.0.0 certifi==2026.10.23
# Torch pulls filelock and setuptools transitively; pin patched versions along
# with pip so rebuilding the classifier does not restore vulnerable tooling.
RUN pip install --upgrade pip==26.2.2 setuptools==84.2.1 filelock==4.2.5 && pip check
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('Falconsai/nsfw_image_detection', revision='96cb0d0342c7afb80cab76ecc58b265fa44da256', local_dir='/model', allow_patterns=['config.json','preprocessor_config.json','model.safetensors'])"
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HOME=/tmp/huggingface
COPY server.py /app/server.py
USER 1000:1000
EXPOSE 8000
CMD ["python", "/app/server.py"]
