require('dotenv').config();

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const https = require('https');

const app = express();
app.use(bodyParser.json());

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const url = req.url;
    const userAgent = req.get('User-Agent') || 'Unknown';
    const origin = req.get('Origin') || 'No Origin';
    
    // Log all requests with details
    console.log(`\n📡 [${timestamp}] ${method} ${url}`);
    console.log(`   🌐 Origin: ${origin}`);
    console.log(`   🤖 User-Agent: ${userAgent}`);
    
    // Log request body for POST requests
    if (method === 'POST' && req.body && Object.keys(req.body).length > 0) {
        console.log(`   📤 Body: ${JSON.stringify(req.body, null, 2)}`);
    }
    
    // Log query parameters if present
    if (Object.keys(req.query).length > 0) {
        console.log(`   🔍 Query: ${JSON.stringify(req.query)}`);
    }
    
    // Track response
    const originalSend = res.send;
    res.send = function(data) {
        console.log(`   ✅ Response: ${res.statusCode} (${typeof data === 'string' ? data.length : JSON.stringify(data).length} chars)`);
        originalSend.call(this, data);
    };
    
    next();
});

// CORS headers and Content-Type for OpenAI Connector
app.use((req, res, next) => {
    // Set CORS headers
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    // Set default Content-Type for JSON responses
    res.header('Content-Type', 'application/json');
    
    if (req.method === 'OPTIONS') {
        console.log(`   🔧 OPTIONS preflight request handled`);
        res.sendStatus(200);
    } else {
        next();
    }
});

const PORT = process.env.PORT || 3000;

// HTTPS agent to handle self-signed certs in test environments
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

console.log('🚀 Starting iManage MCP Server...');
console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`🌐 Port: ${PORT}`);
console.log(`📁 iManage Library: ${process.env.LIBRARY_ID || 'Not configured'}`);

// Token cache to avoid re-authentication for each request
let tokenCache = {
    token: null,
    expires: null
};

// Authenticate and get access token
async function getAccessToken() {
    // Check if we have a valid cached token
    if (tokenCache.token && tokenCache.expires && new Date() < tokenCache.expires) {
        console.log('✅ Using cached access token');
        return tokenCache.token;
    }

    console.log('🔐 Authenticating to iManage...');
    
    const rawBody = `username=${process.env._USERNAME}&` +
                    `password=${process.env.PASSWORD}&` +
                    `grant_type=password&` +
                    `client_id=${process.env.CLIENT_ID}&` +
                    `client_secret=${process.env.CLIENT_SECRET}`;

    try {
        const tokenUrl = `${process.env.AUTH_URL_PREFIX}/oauth2/token?scope=admin`;
        
        const authResponse = await axios.post(
            tokenUrl,
            rawBody,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': '*/*',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive'
                },
                httpsAgent
            }
        );

        const accessToken = authResponse.data.access_token;
        const expiresIn = authResponse.data.expires_in || 1800; // Default to 30 minutes
        
        // Cache the token with expiry (subtract 60 seconds for safety margin)
        tokenCache.token = accessToken;
        tokenCache.expires = new Date(Date.now() + (expiresIn - 60) * 1000);
        
        console.log('✅ Authentication successful');
        return accessToken;
        
    } catch (error) {
        console.error('❌ Authentication failed:', error.message);
        throw error;
    }
}

// Search documents using title search
app.post('/search-by-title', async (req, res) => {
    const { title, limit = 50 } = req.body;

    if (!title) {
        return res.status(400).json({ error: 'Missing required field: title' });
    }

    try {
        console.log(`\n=== Title Search Request: "${title}" ===`);
        
        const accessToken = await getAccessToken();
        
        // Use GET endpoint for title search
        const searchUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents`;
        
        console.log(`🔍 Searching by title: ${searchUrl}`);
        
        const searchResponse = await axios.get(searchUrl, {
            headers: {
                'X-Auth-Token': accessToken
            },
            params: {
                title: title,
                limit: limit,
                latest: true // Only get latest versions
            },
            httpsAgent
        });

        console.log(`✅ Found ${searchResponse.data.data?.length || 0} documents`);
        
        // Handle different possible response structures from iManage
        const iManageData = searchResponse.data.data || searchResponse.data.results || searchResponse.data || [];
        const results = Array.isArray(iManageData) ? iManageData : (iManageData.results || []);
        const total = searchResponse.data.total || searchResponse.data.count || results.length || 0;
        
        console.log(`✅ Found ${results.length} documents`);
        
        res.json({
            success: true,
            searchType: 'title',
            searchTerm: title,
            results: results, // Return flat array, not nested object
            total: total,
            rawResponseKeys: Object.keys(searchResponse.data) // Debug info
        });

    } catch (error) {
        console.error('\n❌ Error in title search:', error.message);
        res.status(500).json({
            error: 'Title search failed',
            message: error.message,
            searchTerm: title
        });
    }
});

// Search documents using keyword search (body content)
app.post('/search-by-keywords', async (req, res) => {
    const { keywords, searchIn = 'anywhere', limit = 50 } = req.body;

    if (!keywords) {
        return res.status(400).json({ error: 'Missing required field: keywords' });
    }

    try {
        console.log(`\n=== Keyword Search Request: "${keywords}" in "${searchIn}" ===`);
        
        const accessToken = await getAccessToken();
        
        // Use GET endpoint for keyword search
        const searchUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents`;
        
        console.log(`🔍 Searching by keywords: ${searchUrl}`);
        
        const params = {
            limit: limit,
            latest: true
        };

        // Set the appropriate search parameter based on searchIn value
        switch (searchIn) {
            case 'body':
                params.body = keywords;
                break;
            case 'comments':
                params.comments = keywords;
                break;
            case 'title':
                params.title = keywords;
                break;
            case 'anywhere':
            default:
                params.anywhere = keywords;
                break;
        }
        
        const searchResponse = await axios.get(searchUrl, {
            headers: {
                'X-Auth-Token': accessToken
            },
            params: params,
            httpsAgent
        });

        console.log(`✅ Found ${searchResponse.data.data?.length || 0} documents`);
        
        // Handle different possible response structures from iManage
        const iManageData = searchResponse.data.data || searchResponse.data.results || searchResponse.data || [];
        const results = Array.isArray(iManageData) ? iManageData : (iManageData.results || []);
        const total = searchResponse.data.total || searchResponse.data.count || results.length || 0;
        
        console.log(`✅ Found ${results.length} documents`);
        
        res.json({
            success: true,
            searchType: 'keywords',
            searchIn: searchIn,
            searchTerm: keywords,
            results: results, // Return flat array, not nested object
            total: total,
            rawResponseKeys: Object.keys(searchResponse.data) // Debug info
        });

    } catch (error) {
        console.error('\n❌ Error in keyword search:', error.message);
        res.status(500).json({
            error: 'Keyword search failed',
            message: error.message,
            searchTerm: keywords
        });
    }
});

// Advanced search using POST endpoint for complex queries
app.post('/search-advanced', async (req, res) => {
    const { filters, profileFields, limit = 50 } = req.body;

    if (!filters || Object.keys(filters).length === 0) {
        return res.status(400).json({ error: 'Missing required field: filters' });
    }

    try {
        console.log(`\n=== Advanced Search Request ===`);
        console.log('Filters:', JSON.stringify(filters, null, 2));
        
        const accessToken = await getAccessToken();
        
        // Use POST endpoint for advanced search
        const searchUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents/search`;
        
        console.log(`🔍 Advanced search: ${searchUrl}`);
        
        const requestBody = {
            limit: limit,
            filters: filters
        };

        // Add profile fields if specified
        if (profileFields) {
            requestBody.profile_fields = profileFields;
        }
        
        const searchResponse = await axios.post(searchUrl, requestBody, {
            headers: {
                'X-Auth-Token': accessToken,
                'Content-Type': 'application/json'
            },
            httpsAgent
        });

        console.log(`✅ Found ${searchResponse.data.data?.length || 0} documents`);
        
        // Handle different possible response structures from iManage
        const iManageData = searchResponse.data.data || searchResponse.data.results || searchResponse.data || [];
        const results = Array.isArray(iManageData) ? iManageData : (iManageData.results || []);
        const total = searchResponse.data.total || searchResponse.data.count || results.length || 0;
        
        console.log(`✅ Found ${results.length} documents`);
        
        res.json({
            success: true,
            searchType: 'advanced',
            filters: filters,
            results: results, // Return flat array, not nested object
            total: total,
            rawResponseKeys: Object.keys(searchResponse.data) // Debug info
        });

    } catch (error) {
        console.error('\n❌ Error in advanced search:', error.message);
        res.status(500).json({
            error: 'Advanced search failed',
            message: error.message,
            filters: filters
        });
    }
});

// Download and read document content
app.post('/download-document', async (req, res) => {
    const { docId, returnContent = false } = req.body;

    if (!docId) {
        return res.status(400).json({ error: 'Missing required field: docId' });
    }

    try {
        console.log(`\n=== Document Download Request: ${docId} ===`);
        
        const accessToken = await getAccessToken();
        
        // Download document
        const downloadUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents/${docId}/download`;
        console.log(`📥 Downloading from: ${downloadUrl}`);

        const downloadResponse = await axios.get(downloadUrl, {
            headers: {
                'X-Auth-Token': accessToken
            },
            responseType: returnContent ? 'arraybuffer' : 'stream',
            httpsAgent
        });

        console.log('✅ Document downloaded successfully');
        
        if (returnContent) {
            // Return the content as base64 for text processing
            const buffer = Buffer.from(downloadResponse.data);
            res.json({
                success: true,
                docId: docId,
                contentType: downloadResponse.headers['content-type'] || 'application/octet-stream',
                size: buffer.length,
                content: buffer.toString('base64')
            });
        } else {
            // Return the document as a file download
            res.setHeader('Content-Type', downloadResponse.headers['content-type'] || 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="document-${docId}.pdf"`);
            res.send(downloadResponse.data);
        }

    } catch (error) {
        console.error('\n❌ Error downloading document:', error.message);
        res.status(500).json({
            error: 'Document download failed',
            message: error.message,
            docId: docId
        });
    }
});

// Get document details/metadata
app.post('/get-document-details', async (req, res) => {
    const { docId } = req.body;

    if (!docId) {
        return res.status(400).json({ error: 'Missing required field: docId' });
    }

    try {
        console.log(`\n=== Document Details Request: ${docId} ===`);
        
        const accessToken = await getAccessToken();
        
        // Get document details
        const detailsUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents/${docId}`;
        console.log(`📋 Getting details from: ${detailsUrl}`);

        const detailsResponse = await axios.get(detailsUrl, {
            headers: {
                'X-Auth-Token': accessToken
            },
            httpsAgent
        });

        console.log('✅ Document details retrieved successfully');
        
        res.json({
            success: true,
            docId: docId,
            details: detailsResponse.data.data
        });

    } catch (error) {
        console.error('\n❌ Error getting document details:', error.message);
        res.status(500).json({
            error: 'Failed to get document details',
            message: error.message,
            docId: docId
        });
    }
});

// Batch search - perform multiple searches in one request
app.post('/batch-search', async (req, res) => {
    const { searches } = req.body;

    if (!searches || !Array.isArray(searches) || searches.length === 0) {
        return res.status(400).json({ error: 'Missing required field: searches (array)' });
    }

    try {
        console.log(`\n=== Batch Search Request: ${searches.length} searches ===`);
        
        const results = [];
        
        for (let i = 0; i < searches.length; i++) {
            const search = searches[i];
            console.log(`🔍 Executing search ${i + 1}/${searches.length}: ${search.type}`);
            
            try {
                let searchResult;
                
                switch (search.type) {
                    case 'title':
                        searchResult = await performTitleSearch(search.query, search.limit || 50);
                        break;
                    case 'keywords':
                        searchResult = await performKeywordSearch(search.query, search.searchIn || 'anywhere', search.limit || 50);
                        break;
                    case 'advanced':
                        searchResult = await performAdvancedSearch(search.filters, search.profileFields, search.limit || 50);
                        break;
                    default:
                        throw new Error(`Unknown search type: ${search.type}`);
                }
                
                results.push({
                    searchIndex: i,
                    searchType: search.type,
                    success: true,
                    ...searchResult
                });
                
            } catch (error) {
                console.error(`❌ Search ${i + 1} failed:`, error.message);
                results.push({
                    searchIndex: i,
                    searchType: search.type,
                    success: false,
                    error: error.message
                });
            }
        }
        
        console.log(`✅ Batch search completed: ${results.filter(r => r.success).length}/${searches.length} successful`);
        
        res.json({
            success: true,
            totalSearches: searches.length,
            successfulSearches: results.filter(r => r.success).length,
            results: results
        });

    } catch (error) {
        console.error('\n❌ Error in batch search:', error.message);
        res.status(500).json({
            error: 'Batch search failed',
            message: error.message
        });
    }
});

// Helper function for title search
async function performTitleSearch(title, limit = 50) {
    const accessToken = await getAccessToken();
    const searchUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents`;
    
    const searchResponse = await axios.get(searchUrl, {
        headers: { 'X-Auth-Token': accessToken },
        params: { title: title, limit: limit, latest: true },
        httpsAgent
    });

    const iManageData = searchResponse.data.data || searchResponse.data.results || searchResponse.data || [];
    const results = Array.isArray(iManageData) ? iManageData : (iManageData.results || []);

    return {
        searchTerm: title,
        results: results,
        total: searchResponse.data.total || results.length || 0
    };
}

// Helper function for keyword search
async function performKeywordSearch(keywords, searchIn = 'anywhere', limit = 50) {
    const accessToken = await getAccessToken();
    const searchUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents`;
    
    const params = { limit: limit, latest: true };
    params[searchIn] = keywords;
    
    const searchResponse = await axios.get(searchUrl, {
        headers: { 'X-Auth-Token': accessToken },
        params: params,
        httpsAgent
    });

    const iManageData = searchResponse.data.data || searchResponse.data.results || searchResponse.data || [];
    const results = Array.isArray(iManageData) ? iManageData : (iManageData.results || []);

    return {
        searchTerm: keywords,
        searchIn: searchIn,
        results: results,
        total: searchResponse.data.total || results.length || 0
    };
}

// Helper function for advanced search
async function performAdvancedSearch(filters, profileFields, limit = 50) {
    const accessToken = await getAccessToken();
    const searchUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents/search`;
    
    const requestBody = { limit: limit, filters: filters };
    if (profileFields) {
        requestBody.profile_fields = profileFields;
    }
    
    const searchResponse = await axios.post(searchUrl, requestBody, {
        headers: {
            'X-Auth-Token': accessToken,
            'Content-Type': 'application/json'
        },
        httpsAgent
    });

    const iManageData = searchResponse.data.data || searchResponse.data.results || searchResponse.data || [];
    const results = Array.isArray(iManageData) ? iManageData : (iManageData.results || []);

    return {
        filters: filters,
        results: results,
        total: searchResponse.data.total || results.length || 0
    };
}

// Legacy endpoint for backward compatibility (Scenario A)
app.post('/fetch-document', async (req, res) => {
    const { docId } = req.body;

    if (!docId) {
        return res.status(400).json({ error: 'Missing required field: docId' });
    }

    try {
        console.log(`\n=== Legacy Document Fetch: ${docId} ===`);
        
        const accessToken = await getAccessToken();
        
        const downloadUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents/${docId}/download`;
        console.log(`📥 Downloading from: ${downloadUrl}`);

        const downloadResponse = await axios.get(downloadUrl, {
            headers: {
                'X-Auth-Token': accessToken
            },
            responseType: 'arraybuffer',
            httpsAgent
        });

        console.log('✅ Document downloaded successfully');
        res.setHeader('Content-Type', 'application/pdf');
        res.send(downloadResponse.data);

    } catch (error) {
        console.error('\n❌ Error in legacy fetch:', error.message);
        res.status(500).json({
            error: 'Failed to fetch document',
            message: error.message,
            docId: docId
        });
    }
});

// OpenAI Connector spec requires this exact endpoint
app.get('/.well-known/ai-plugin.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    res.json({
        schema_version: "v1",
        name_for_human: "iManage Deep Research",
        name_for_model: "imanage_research", 
        description_for_human: "Search and analyze documents in iManage for comprehensive research reports",
        description_for_model: "Tool for searching iManage documents using title, keyword, and advanced search strategies, plus document content retrieval for analysis and report generation.",
        auth: {
            type: "none"
        },
        api: {
            type: "openapi",
            url: `${req.protocol}://${req.get('host')}/openapi.json`
        },
        logo_url: null,
        contact_email: "support@example.com",
        legal_info_url: "https://example.com/legal"
    });
});

// OpenAPI specification endpoint
app.get('/openapi.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    
    res.json({
        openapi: "3.0.1",
        info: {
            title: "iManage Deep Research API",
            description: "Search and analyze iManage documents for comprehensive research",
            version: "2.0.0"
        },
        servers: [
            {
                url: baseUrl
            }
        ],
        paths: {
            "/search": {
                post: {
                    operationId: "searchDocuments",
                    summary: "Search iManage documents",
                    description: "Search for documents using various strategies including title, keywords, advanced filters, and batch operations",
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        query: {
                                            type: "string",
                                            description: "Search query or keywords"
                                        },
                                        search_type: {
                                            type: "string",
                                            enum: ["title", "keywords", "advanced", "batch"],
                                            description: "Type of search to perform",
                                            default: "keywords"
                                        },
                                        search_in: {
                                            type: "string",
                                            enum: ["anywhere", "body", "comments", "title"],
                                            description: "Where to search for keywords",
                                            default: "anywhere"
                                        },
                                        filters: {
                                            type: "object",
                                            description: "Advanced search filters"
                                        },
                                        limit: {
                                            type: "integer",
                                            description: "Maximum number of results",
                                            default: 50,
                                            minimum: 1,
                                            maximum: 200
                                        }
                                    },
                                    required: ["query"]
                                }
                            }
                        }
                    },
                    responses: {
                        "200": {
                            description: "Search results",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            results: {
                                                type: "array",
                                                items: {
                                                    type: "object",
                                                    properties: {
                                                        id: { type: "string" },
                                                        title: { type: "string" },
                                                        summary: { type: "string" },
                                                        url: { type: ["string", "null"] },
                                                        metadata: { type: "object" }
                                                    }
                                                }
                                            },
                                            total: { type: "integer" },
                                            search_type: { type: "string" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "/fetch": {
                post: {
                    operationId: "fetchDocument",
                    summary: "Fetch document content",
                    description: "Retrieve detailed content and metadata for a specific document",
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": {
                                schema: {
                                    type: "object",
                                    properties: {
                                        id: {
                                            type: "string",
                                            description: "Document ID"
                                        },
                                        include_content: {
                                            type: "boolean",
                                            description: "Whether to include document content",
                                            default: true
                                        }
                                    },
                                    required: ["id"]
                                }
                            }
                        }
                    },
                    responses: {
                        "200": {
                            description: "Document content and metadata",
                            content: {
                                "application/json": {
                                    schema: {
                                        type: "object",
                                        properties: {
                                            id: { type: "string" },
                                            title: { type: "string" },
                                            text: { type: "string" },
                                            url: { type: ["string", "null"] },
                                            metadata: { type: "object" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: {
            authUrlPrefix: process.env.AUTH_URL_PREFIX,
            urlPrefix: process.env.URL_PREFIX,
            customerId: process.env.CUSTOMER_ID,
            libraryId: process.env.LIBRARY_ID
        }
    });
});

// OpenAI Connector Tool Discovery Endpoint (OpenAI Function Calling Format)
app.get('/tools', (req, res) => {
    // Ensure proper headers and clean response
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200);
    
    res.json([
        {
            type: "function",
            description: "Search for documents using various strategies and filters",
            function: {
                name: "search",
                description: "Search iManage documents using various strategies including title search, keyword search, advanced filters, and batch operations for comprehensive document discovery",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Search query or keywords to find relevant documents"
                        },
                        search_type: {
                            type: "string",
                            enum: ["title", "keywords", "advanced", "batch"],
                            description: "Type of search strategy: 'title' for document names, 'keywords' for content search, 'advanced' for filtered search, 'batch' for comprehensive multi-strategy search",
                            default: "keywords"
                        },
                        search_in: {
                            type: "string", 
                            enum: ["anywhere", "body", "comments", "title"],
                            description: "Scope of keyword search: 'anywhere' searches all fields, 'body' searches document content, 'comments' searches document comments, 'title' searches document names",
                            default: "anywhere"
                        },
                        filters: {
                            type: "object",
                            description: "Advanced search filters for precise document filtering (used with 'advanced' search_type)",
                            properties: {
                                type: { 
                                    type: "string", 
                                    description: "Document file type filter (e.g., WORD, ACROBAT, EXCEL)" 
                                },
                                author: { 
                                    type: "string", 
                                    description: "Filter by document author (user ID or email)" 
                                },
                                edit_date_from: { 
                                    type: "string", 
                                    description: "Filter documents modified after this date (ISO 8601 format: YYYY-MM-DDTHH:mm:ssZ)" 
                                },
                                edit_date_to: { 
                                    type: "string", 
                                    description: "Filter documents modified before this date (ISO 8601 format: YYYY-MM-DDTHH:mm:ssZ)" 
                                },
                                workspace_id: {
                                    type: "string",
                                    description: "Filter by specific workspace/container ID"
                                }
                            }
                        },
                        limit: {
                            type: "integer",
                            description: "Maximum number of documents to return in search results",
                            default: 50,
                            minimum: 1,
                            maximum: 200
                        }
                    },
                    required: ["query"]
                }
            }
        },
        {
            type: "function",
            description: "Fetch document metadata and content by ID",
            function: {
                name: "fetch",
                description: "Retrieve detailed content and comprehensive metadata for a specific document identified by its ID, including document text content for analysis and research purposes",
                parameters: {
                    type: "object",
                    properties: {
                        id: {
                            type: "string",
                            description: "Unique document identifier (e.g., 'Legal_QA!3402.1') obtained from search results"
                        },
                        include_content: {
                            type: "boolean",
                            description: "Whether to include the actual document content (base64 encoded) for text analysis and research. Set to true for document analysis, false for metadata only",
                            default: true
                        }
                    },
                    required: ["id"]
                }
            }
        }
    ]);
});

// Unified search endpoint for OpenAI Connector
app.post('/search', async (req, res) => {
    const { query, search_type = 'keywords', search_in = 'anywhere', filters, limit = 50 } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Missing required field: query' });
    }

    try {
        console.log(`\n=== OpenAI Connector Search: "${query}" (${search_type}) ===`);
        
        let searchResult;
        
        switch (search_type) {
            case 'title':
                searchResult = await performTitleSearch(query, limit);
                break;
            case 'keywords':
                searchResult = await performKeywordSearch(query, search_in, limit);
                break;
            case 'advanced':
                searchResult = await performAdvancedSearch(filters || { anywhere: query }, null, limit);
                break;
            case 'batch':
                // For batch, create multiple searches from the query
                const searches = [
                    { type: 'keywords', query: query, searchIn: 'anywhere', limit: Math.floor(limit/3) },
                    { type: 'title', query: query, limit: Math.floor(limit/3) },
                    { type: 'keywords', query: query, searchIn: 'body', limit: Math.floor(limit/3) }
                ];
                const batchResult = await performBatchSearch(searches);
                // Flatten batch results for unified response
                searchResult = {
                    searchTerm: query,
                    results: batchResult.results.flatMap(r => r.success ? r.results : []),
                    total: batchResult.results.reduce((sum, r) => sum + (r.success ? r.results.length : 0), 0)
                };
                break;
            default:
                throw new Error(`Unknown search type: ${search_type}`);
        }

        // Transform results to OpenAI format
        const transformedResults = searchResult.results.map(doc => ({
            id: doc.id,
            title: doc.name || doc.id,
            summary: `${doc.workspace_name || 'Unknown workspace'} - ${doc.custom1_description || ''} ${doc.custom2_description || ''} - ${doc.type_description || doc.type || 'Unknown type'} (${formatFileSize(doc.size || 0)})`.trim(),
            url: doc.iwl || null,
            metadata: {
                author: doc.author_description || doc.author || 'Unknown',
                workspace: doc.workspace_name || 'Unknown',
                size: (doc.size || 0).toString(),
                edit_date: doc.edit_date || 'Unknown',
                document_type: doc.type_description || doc.type || 'Unknown',
                custom1: doc.custom1_description || '',
                custom2: doc.custom2_description || '',
                custom3: doc.custom3_description || ''
            }
        }));

        res.status(200).json({
            results: transformedResults,
            total: searchResult.total || transformedResults.length,
            search_type: search_type
        });

    } catch (error) {
        console.error('\n❌ Error in OpenAI search:', error.message);
        res.status(500).json({
            error: 'Search failed',
            message: error.message,
            query: query
        });
    }
});

// Unified fetch endpoint for OpenAI Connector  
app.post('/fetch', async (req, res) => {
    const { id, include_content = true } = req.body;

    if (!id) {
        return res.status(400).json({ error: 'Missing required field: id' });
    }

    try {
        console.log(`\n=== OpenAI Connector Fetch: ${id} ===`);
        
        const accessToken = await getAccessToken();
        
        // Get document details
        const detailsUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents/${id}`;
        const detailsResponse = await axios.get(detailsUrl, {
            headers: { 'X-Auth-Token': accessToken },
            httpsAgent
        });

        const doc = detailsResponse.data.data;
        let content = '';

        if (include_content) {
            // Download document content
            const downloadUrl = `${process.env.URL_PREFIX}/api/v2/customers/${process.env.CUSTOMER_ID}/libraries/${process.env.LIBRARY_ID}/documents/${id}/download`;
            const downloadResponse = await axios.get(downloadUrl, {
                headers: { 'X-Auth-Token': accessToken },
                responseType: 'arraybuffer',
                httpsAgent
            });

            const buffer = Buffer.from(downloadResponse.data);
            content = `Document content (${formatFileSize(buffer.length)} ${doc.type || 'file'}): ${buffer.toString('base64')}`;
        }

        res.status(200).json({
            id: doc.id,
            title: doc.name || doc.id,
            text: content,
            url: doc.iwl || null,
            metadata: {
                author: doc.author_description || doc.author || 'Unknown',
                author_email: doc.author || '',
                workspace: doc.workspace_name || 'Unknown',
                workspace_id: doc.workspace_id || '',
                size: (doc.size || 0).toString(),
                edit_date: doc.edit_date || 'Unknown',
                create_date: doc.create_date || 'Unknown',
                document_type: doc.type_description || doc.type || 'Unknown',
                extension: doc.extension || '',
                version: (doc.version || 1).toString(),
                custom1: doc.custom1_description || '',
                custom2: doc.custom2_description || '',
                custom3: doc.custom3_description || '',
                database: doc.database || '',
                document_number: (doc.document_number || '').toString(),
                last_user: doc.last_user_description || doc.last_user || '',
                default_security: doc.default_security || 'private'
            }
        });

        console.log('✅ Document fetched successfully for OpenAI Connector');

    } catch (error) {
        console.error('\n❌ Error in OpenAI fetch:', error.message);
        res.status(500).json({
            error: 'Fetch failed',
            message: error.message,
            id: id
        });
    }
});

// Helper function to format file sizes
// Root endpoint with API documentation
app.get('/', (req, res) => {
    res.json({
        message: 'iManage MCP Server for Deep Research',
        version: '2.0.0',
        scenario: 'B - Deep Research',
        openai_connector: {
            tools_endpoint: '/tools',
            search_endpoint: '/search', 
            fetch_endpoint: '/fetch'
        },
        legacy_endpoints: {
            '/search-by-title': 'POST - Search documents by title',
            '/search-by-keywords': 'POST - Search documents by keywords in body/anywhere/comments',
            '/search-advanced': 'POST - Advanced search with complex filters',
            '/download-document': 'POST - Download document content',
            '/get-document-details': 'POST - Get document metadata',
            '/batch-search': 'POST - Perform multiple searches in one request',
            '/fetch-document': 'POST - Legacy endpoint (Scenario A compatibility)',
            '/health': 'GET - Health check'
        },
        usage: {
            openai_connector: {
                tools_discovery: 'GET /tools',
                search: 'POST /search',
                fetch: 'POST /fetch'
            },
            legacy_usage: {
                titleSearch: {
                    endpoint: '/search-by-title',
                    body: { title: 'contract agreement', limit: 50 }
                },
                keywordSearch: {
                    endpoint: '/search-by-keywords', 
                    body: { keywords: 'litigation', searchIn: 'anywhere', limit: 50 }
                }
            }
        }
    });
});

// Helper function for batch search
async function performBatchSearch(searches) {
    const results = [];
    
    for (let i = 0; i < searches.length; i++) {
        const search = searches[i];
        console.log(`  Executing search ${i + 1}/${searches.length}: ${search.type}`);
        
        try {
            let searchResult;
            
            switch (search.type) {
                case 'title':
                    searchResult = await performTitleSearch(search.query, search.limit || 50);
                    break;
                case 'keywords':
                    searchResult = await performKeywordSearch(search.query, search.searchIn || 'anywhere', search.limit || 50);
                    break;
                case 'advanced':
                    searchResult = await performAdvancedSearch(search.filters, search.profileFields, search.limit || 50);
                    break;
                default:
                    throw new Error(`Unknown search type: ${search.type}`);
            }
            
            results.push({
                searchIndex: i,
                searchType: search.type,
                success: true,
                ...searchResult
            });
            
        } catch (error) {
            console.error(`❌ Search ${i + 1} failed:`, error.message);
            results.push({
                searchIndex: i,
                searchType: search.type,
                success: false,
                error: error.message
            });
        }
    }
    
    return {
        totalSearches: searches.length,
        successfulSearches: results.filter(r => r.success).length,
        results: results
    };
}

app.listen(PORT, () => {
    console.log(`🚀 Enhanced MCP Server running at http://localhost:${PORT}`);
    console.log(`📋 Scenario B: Deep Research with iManage Work API`);
    console.log(`🔍 Features: Title Search, Keyword Search, Advanced Search, Batch Operations`);
    console.log(`🌐 Environment: ${process.env.URL_PREFIX}`);
    console.log(`📁 Library: ${process.env.LIBRARY_ID}`);
    
    // Show deployment info
    if (process.env.RENDER) {
        console.log(`🚀 Deployed on Render`);
        console.log(`🔗 Public URL: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-app.onrender.com'}`);
    } else {
        console.log(`💻 Running locally`);
    }
    
    console.log(`\n📡 Available endpoints:`);
    console.log(`   GET  /health - Health check`);
    console.log(`   GET  /tools - OpenAI tool discovery`);
    console.log(`   POST /search - Unified search endpoint`);
    console.log(`   POST /fetch - Document retrieval`);
    console.log(`   GET  /.well-known/ai-plugin.json - OpenAI plugin manifest`);
});