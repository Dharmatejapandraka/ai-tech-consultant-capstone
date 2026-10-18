from app.main import chunk_text
def test_chunking_returns_content():
    text = " ".join(f"word{i}" for i in range(2200))
    chunks = chunk_text(text, size=300, overlap=30)
    assert len(chunks) > 1
    assert all(c.strip() for c in chunks)
