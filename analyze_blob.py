import base64
import re
import struct

def analyze_blob(file_path):
    with open(file_path, 'r') as f:
        b64_data = f.read().strip()
    
    blob = base64.b64decode(b64_data)
    print(f"Blob size: {len(blob)} bytes")
    
    # UUID pattern: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    uuid_pattern = re.compile(rb'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
    
    matches = list(uuid_pattern.finditer(blob))
    print(f"Found {len(matches)} UUIDs")
    
    results = []
    for match in matches:
        start = match.start()
        end = match.end()
        uuid_str = match.group().decode('utf-8')
        
        # Look at the 64 bytes following the UUID to find potential timestamps
        next_chunk = blob[end:end+64]
        
        # In Protobuf, timestamps are often 64-bit integers (varint or fixed64)
        # 17xxxxxxxxx in ms is a common timestamp for 2024-2026.
        # Let's try to find them.
        
        results.append({
            'uuid': uuid_str,
            'pos': start,
            'snippet': next_chunk.hex()
        })
    
    # Print the results in order of appearance in the blob
    print("\nUUIDs in order of appearance in BLOB:")
    for i, res in enumerate(results):
        print(f"[{i:02d}] Pos: {res['pos']:06d} | UUID: {res['uuid']} | Snippet: {res['snippet'][:30]}...")

if __name__ == "__main__":
    analyze_blob('trajectory_blob.b64')
