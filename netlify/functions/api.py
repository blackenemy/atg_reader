import json
import sys
sys.path.insert(0, '/var/task')

from app import app

def handler(event, context):
    """Netlify serverless function wrapper for Flask app"""
    # Convert Netlify event to Flask request
    path = event.get('path', '')
    method = event.get('httpMethod', 'GET')
    body = event.get('body', '')
    headers = event.get('headers', {})
    
    # Create a test request context
    with app.test_client() as client:
        response = client.open(
            path,
            method=method,
            data=body,
            headers=headers
        )
        
        return {
            'statusCode': response.status_code,
            'headers': dict(response.headers),
            'body': response.get_data(as_text=True)
        }
