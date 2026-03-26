import chromadb

client = chromadb.PersistentClient(path="./chroma_db")
print(client.list_collections())  # Shows all collections

collection = client.get_collection("call_transcripts")
data = collection.get(include=["metadatas", "documents", "embeddings"])
print(f"Total items: {len(data['ids'])}")
print("Sample:", data['documents'][0])  # First document
