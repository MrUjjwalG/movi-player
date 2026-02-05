#!/usr/bin/env python3
"""
Simple HTTP server for running the dist build example.
Requires Python 3.6+ and sets the necessary headers for SharedArrayBuffer.
Supports Brotli compression (with fallback to GZIP).
Install: pip install brotli
"""

import http.server
import socketserver
import os
import sys
import gzip
import io
from pathlib import Path

# Try to import Brotli (optional, falls back to GZIP if not available)
try:
    import brotli
    BROTLI_AVAILABLE = True
except ImportError:
    BROTLI_AVAILABLE = False
    print("Warning: brotli module not found. Install with: pip install brotli")
    print("Falling back to GZIP compression only.")

# Get the project root directory (two levels up from examples)
PROJECT_ROOT = Path(__file__).parent.parent
EXAMPLES_DIR = PROJECT_ROOT / 'examples'
DIST_DIR = PROJECT_ROOT / 'dist'

PORT = 8000

class CustomHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Map /dist/ paths to the actual dist directory
        if path.startswith('/dist/'):
            # Remove leading /dist/ and map to PROJECT_ROOT/dist/
            file_path = path[6:]  # Remove '/dist/'
            return str(DIST_DIR / file_path)
        # For all other paths, use default behavior (served from examples directory)
        return super().translate_path(path)
    
    def do_GET(self):
        # Check if client accepts Brotli or GZIP encoding
        accept_encoding = self.headers.get('Accept-Encoding', '')
        use_brotli = BROTLI_AVAILABLE and 'br' in accept_encoding
        use_gzip = 'gzip' in accept_encoding
        
        # Get file path
        file_path = self.translate_path(self.path)
        
        # Check if file exists
        if not os.path.isfile(file_path):
            super().do_GET()
            return
        
        # Get file extension to determine compressible types
        file_ext = Path(file_path).suffix.lower()
        compressible_types = {'.js', '.css', '.html', '.json', '.svg', '.xml', '.txt', '.wasm'}
        
        try:
            with open(file_path, 'rb') as f:
                content = f.read()
            
            # Only compress text/binary files, not images
            should_compress = file_ext in compressible_types
            
            if should_compress and use_brotli:
                # Compress with Brotli (best compression, ~10-25% better than GZIP)
                compressed_content = brotli.compress(content, quality=6)  # quality 1-11, 6 is good balance
                
                # Send Brotli-compressed response
                self.send_response(200)
                self.send_header('Content-Type', self.guess_type(file_path))
                self.send_header('Content-Length', str(len(compressed_content)))
                self.send_header('Content-Encoding', 'br')
                self.send_header('Vary', 'Accept-Encoding')
                # Required headers for SharedArrayBuffer support
                self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
                self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
                self.end_headers()
                self.wfile.write(compressed_content)
            elif should_compress and use_gzip:
                # Fallback to GZIP compression
                gzip_buffer = io.BytesIO()
                with gzip.GzipFile(fileobj=gzip_buffer, mode='wb', compresslevel=6) as gzip_file:
                    gzip_file.write(content)
                compressed_content = gzip_buffer.getvalue()
                
                # Send GZIP-compressed response
                self.send_response(200)
                self.send_header('Content-Type', self.guess_type(file_path))
                self.send_header('Content-Length', str(len(compressed_content)))
                self.send_header('Content-Encoding', 'gzip')
                self.send_header('Vary', 'Accept-Encoding')
                # Required headers for SharedArrayBuffer support
                self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
                self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
                self.end_headers()
                self.wfile.write(compressed_content)
            else:
                # Send uncompressed response
                self.send_response(200)
                self.send_header('Content-Type', self.guess_type(file_path))
                self.send_header('Content-Length', str(len(content)))
                # Required headers for SharedArrayBuffer support
                self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
                self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
                self.end_headers()
                self.wfile.write(content)
        except Exception as e:
            self.send_error(404, f"File not found: {str(e)}")
    
    def end_headers(self):
        # This method is called by super().do_GET() if we don't override do_GET
        # Required headers for SharedArrayBuffer support
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

    def log_message(self, format, *args):
        # Custom logging
        sys.stderr.write("%s - - [%s] %s\n" %
                        (self.address_string(),
                         self.log_date_time_string(),
                         format%args))

def main():
    # Change to examples directory to serve from there
    os.chdir(EXAMPLES_DIR)
    
    # Check if dist directory exists (relative to project root)
    if not DIST_DIR.exists():
        print(f"Error: dist directory not found at {DIST_DIR}")
        print("Please run 'npm run build' first to build the project.")
        sys.exit(1)
    
    # Check if the example file exists
    example_file = EXAMPLES_DIR / 'index.html'
    if not example_file.exists():
        print(f"Error: example file not found at {example_file}")
        sys.exit(1)
    
    handler = CustomHTTPRequestHandler
    
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        print(f"Serving at http://localhost:{PORT}/index.html")
        print(f"Serving from: {EXAMPLES_DIR}")
        if BROTLI_AVAILABLE:
            print("Compression: Brotli (with GZIP fallback) enabled")
        else:
            print("Compression: GZIP only (install 'brotli' for better compression)")
        print(f"Press Ctrl+C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown()

if __name__ == '__main__':
    main()
