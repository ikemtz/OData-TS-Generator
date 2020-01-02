[![Build Status](https://ikemtz.visualstudio.com/CI%20CD/_apis/build/status/OData-TS-Generator?branchName=master)](https://ikemtz.visualstudio.com/CI%20CD/_build/latest?definitionId=21&branchName=master) [![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=odata-ts-generator&metric=alert_status)](https://sonarcloud.io/dashboard?id=odata-ts-generator) [![Coverage](https://sonarcloud.io/api/project_badges/measure?project=odata-ts-generator&metric=coverage)](https://sonarcloud.io/dashboard?id=odata-ts-generator) [![Lines of Code](https://sonarcloud.io/api/project_badges/measure?project=odata-ts-generator&metric=ncloc)](https://sonarcloud.io/dashboard?id=odata-ts-generator) [![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=odata-ts-generator&metric=security_rating)](https://sonarcloud.io/dashboard?id=odata-ts-generator) [![npm version](https://badge.fury.io/js/odata-ts-generator.svg)](https://badge.fury.io/js/odata-ts-generator)
 
# OData-TS-Generator
NPM package based on [swagger-ts-generator](https://www.npmjs.com/package/swagger-ts-generator) to generate typescript models for OData endpoints documented by swagger.

## TypeScript Usage
```javascript
import { generateTsModels } from 'odata-ts-generator';

enerateTsModels('{Your Swagger Endpoint here}', './{outputFolder}/');
```

## Javascript Usage
```javascript
const generator = require('odata-ts-generator');

generator.generateTsModels('{Your Swagger Enpoint here}', './{outputFolder}/');
```

## Working Example
```javascript
import { generateTsModels } from 'odata-ts-generator';

generateTsModels('https://petstore.swagger.io/v2/swagger.json', './models/');
```
