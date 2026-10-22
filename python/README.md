# Python

```bash
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python main.py --help
python main.py mcp-sources 123 456 789
```

Configura primero las variables descritas en el [README principal](../README.md).

El cliente usa `httpx`, mantiene conexiones HTTP, autentica de forma diferida y permite
consumir el SSE sin imponer un timeout total de lectura.
