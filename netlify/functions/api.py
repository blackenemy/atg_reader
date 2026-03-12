import json
import os
import sys

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from flask import Flask, request
from app import app as flask_app

def handler(event, context):
    """Netlify serverless function wrapper for Flask"""
    
    with flask_app.test_request_context(
        path=event.get('path', '/'),
        method=event.get('httpMethod', 'GET'),
        data=event.get('body', ''),
        headers=event.get('headers', {})
    ):
        try:
            response = flask_app.full_dispatch_request()
            
            if hasattr(response, 'get_json'):
                body = json.dumps(response.get_json() or {})
            else:
                body = response if isinstance(response, str) else str(response)
            
            return {
                'statusCode': 200,
                'headers': {'Content-Type': 'application/json'},
                'body': body
            }
        except Exception as e:
            return {
                'statusCode': 500,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': str(e)})
            }
