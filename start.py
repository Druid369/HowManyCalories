import subprocess
import sys

PORT = 8000

print()
print("  ┌─────────────────────────────────────┐")
print("  │         HowManyCalories             │")
print("  │                                     │")
print(f"  │   http://localhost:{PORT}            │")
print("  │                                     │")
print("  └─────────────────────────────────────┘")
print()

subprocess.run([
    sys.executable, "-m", "uvicorn",
    "server.main:app",
    "--reload",
    "--host", "0.0.0.0",
    "--port", str(PORT),
])
