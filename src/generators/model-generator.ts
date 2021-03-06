import { readdirSync, unlinkSync } from 'fs';
import { each, endsWith, find, forEach, kebabCase, snakeCase, uniqBy } from 'lodash';
import { join, normalize } from 'path';
import {
  convertNamespaceToPath,
  ensureFolder,
  getDirectories,
  getFileName,
  getImportFile,
  getPathToRoot,
  getSortedObjectProperties,
  isInTypesToFilter,
  log,
  readAndCompileTemplateFile,
  removeExtension,
  removeFolder,
  writeFileIfContentsIsChanged,
} from '../file-utils';
import { GeneratorOptions } from '../models/GeneratorOptions';
import { ITypeMetaData } from '../models/ITypeMetaData';
import { INamespaceGroups } from '../models/NamespaceGroups';
import { ISwagger, ISwaggerDefinition, ISwaggerDefinitionProperties } from '../models/swagger';
import { EnumHelpers } from './enum-helper';
import { NameSpaceHelpers, ROOT_NAMESPACE } from './namespace-helpers';
import { PropertyHelpers } from './property-helper';
import { TypeHelpers } from './type-helper';

const TS_SUFFIX = '.ts';
const MODEL_SUFFIX = '.model';
const MODEL_FILE_SUFFIX = `${MODEL_SUFFIX}${TS_SUFFIX}`;
// const BASE_TYPE_WAIT_FOR_SECOND_PASS = 'wait-for-second-pass';

export function generateModelTSFiles(swagger: ISwagger, options: GeneratorOptions) {
  const folder = normalize(options.modelFolder);
  // generate fixed file with non-standard validators for validation rules which can be defined in the swagger file
  if (options.generateValidatorFile) {
    generateTSValidations(folder, options);
  }
  if (options.generateBaseClass) {
    // generate fixed file with the BaseModel class
    generateTSBaseModel(folder, options);
  }
  // get type definitions from swagger
  const typeCollection = getTypeDefinitions(swagger, options, MODEL_SUFFIX, MODEL_FILE_SUFFIX);

  // group types per namespace
  const namespaceGroups = NameSpaceHelpers.getNamespaceGroups(typeCollection, options);
  // console.log('namespaceGroups', namespaceGroups);
  // generate model files
  generateTSModels(namespaceGroups, folder, options);

  generateFormGroupFactories(namespaceGroups, folder, options);

  // generate subTypeFactory
  if (options.generateSubTypeFactory) {
    generateSubTypeFactory(namespaceGroups, folder, options);
  }

  // generate barrel files (index files to simplify import statements)
  if (options.generateBarrelFiles) {
    generateBarrelFiles(namespaceGroups, folder, options);
  }
}

function generateTSValidations(folder: string, options: GeneratorOptions) {
  if (!options.generateClasses) {
    return;
  }

  const outputFileName = join(folder, options.validatorsFileName);
  const data = {};
  const template = readAndCompileTemplateFile(options.templates.validators);
  let result: string = '';
  try {
    result = template(data);
  } catch (x) {
    console.error(`Error generating ${outputFileName}, this is likely an issue with the template`);
    console.error(`HandleBar file: ${options.templates.validators}`);
    console.error(x);
    throw x;
  }
  ensureFolder(folder);
  const isChanged = writeFileIfContentsIsChanged(outputFileName, result);
  if (isChanged) {
    log(`generated ${outputFileName}`);
  }
}

function generateTSBaseModel(folder: string, options: GeneratorOptions) {
  if (!options.generateClasses) {
    return;
  }

  const outputFileName = join(folder, options.baseModelFileName);
  const data = {
    subTypePropertyName: options.subTypePropertyName,
  };
  const template = readAndCompileTemplateFile(options.templates.baseModel);
  const result = template(data);
  ensureFolder(folder);
  const isChanged = writeFileIfContentsIsChanged(outputFileName, result);
  if (isChanged) {
    log(`generated ${outputFileName}`);
  }
}

function getTypeDefinitions(swagger: ISwagger, options: GeneratorOptions, suffix: string, fileSuffix: string) {
  let typeCollection: ITypeMetaData[] = new Array();
  forEach(swagger.definitions, (item, key) => {
    if (!isInTypesToFilter(item, key, options)) {
      const type = getTypeDefinition(swagger, typeCollection, item, key, options, suffix, fileSuffix);
      if (type) {
        typeCollection.push(type);
      }
    }
  });
  fillMissingBaseTypes(swagger, typeCollection, options, suffix, fileSuffix);

  // fill types of the properties
  fillPropertyTypes(swagger, typeCollection, options, suffix, fileSuffix);

  // filter on unique types
  typeCollection = uniqBy(typeCollection, 'typeName');

  return typeCollection;
}

function getTypeDefinition(
  swagger: ISwagger,
  typeCollection: ITypeMetaData[],
  item: ISwaggerDefinition,
  key: string,
  options: GeneratorOptions,
  suffix: string,
  fileSuffix: string,
) {
  // filter enum types (these are generated by the enumGenerator)
  const isEnumType = EnumHelpers.getIsEnumType(item);
  if (isEnumType) {
    return undefined;
  }

  let required = (item.required as string[]) || [];
  const namespace = NameSpaceHelpers.getNamespace(key, options, true);
  const fullNamespace = NameSpaceHelpers.getNamespace(key, options, false);
  let typeName = TypeHelpers.getTypeName(key, options);
  if (TypeHelpers.getIsGenericType(typeName)) {
    typeName = TypeHelpers.convertGenericToGenericType(typeName);
  }
  const interfaceTypeName = TypeHelpers.getTypeInterfaceName(key, options);
  const fullTypeName = fullNamespace ? `${fullNamespace}.${typeName}` : typeName;
  const pathToRoot = getPathToRoot(namespace);
  const importFile = getImportFile(typeName, namespace, pathToRoot, suffix);
  let properties: ISwaggerDefinitionProperties | null = getSortedObjectProperties(
    item.properties,
  ) as ISwaggerDefinitionProperties;
  let baseType;
  let baseImportFile;
  const isSubType = TypeHelpers.getIsSubType(item);
  const hasSubTypeProperty = isSubType || TypeHelpers.getHasSubTypeProperty(properties, options);
  if (isSubType) {
    baseType = TypeHelpers.getBaseType(typeName, typeCollection, item, options);
    // baseType might not be in the typeCollection yet
    // in that case, a second pass will be done with method fillMissingBaseTypes
    if (baseType) {
      // set that the baseType is a baseType
      baseType.isBaseType = true;
      // determine baseImportFile
      baseImportFile = getImportFile(baseType.typeName, baseType.namespace, pathToRoot, suffix);
      required = TypeHelpers.getSubTypeRequired(item);
      properties = PropertyHelpers.getSubTypeProperties(item, baseType);
    }
  }

  const type: ITypeMetaData = {
    fileName: getFileName(key, options, fileSuffix),
    typeName,
    interfaceTypeName,
    fullNamespace,
    fullTypeName,
    isSubType,
    hasSubTypeProperty,
    importFile,
    isBaseType: false, // set elsewhere
    baseType,
    baseImportFile,
    namespace,
    path: convertNamespaceToPath(namespace),
    pathToRoot,
    properties: [],
  };
  PropertyHelpers.fillTypeProperties(
    swagger,
    type,
    required,
    properties,
    item,
    key,
    options,
    suffix,
    fileSuffix,
    baseType,
  );
  return type;
}

function fillMissingBaseTypes(
  swagger: ISwagger,
  typeCollection: ITypeMetaData[],
  options: GeneratorOptions,
  suffix: string,
  fileSuffix: string,
) {
  forEach(swagger.definitions, (item, key) => {
    const isSubType = TypeHelpers.getIsSubType(item);
    const type = TypeHelpers.findTypeInTypeCollection(typeCollection, key);
    if (isSubType && type && !type.baseType) {
      const namespace = NameSpaceHelpers.getNamespace(key, options, true);
      const pathToRoot = getPathToRoot(namespace);

      const baseType = TypeHelpers.getBaseType(key, typeCollection, item, options);
      if (baseType) {
        // set that the baseType is a baseType
        baseType.isBaseType = true;
        // determine baseImportFile
        const baseImportFile = getImportFile(baseType.typeName, baseType.namespace, pathToRoot, suffix);
        const required = TypeHelpers.getSubTypeRequired(item);
        const properties = PropertyHelpers.getSubTypeProperties(item, baseType);

        type.baseType = baseType;
        type.baseImportFile = baseImportFile;
        PropertyHelpers.fillTypeProperties(
          swagger,
          type,
          required,
          properties,
          item,
          key,
          options,
          suffix,
          fileSuffix,
          baseType,
        );
      }
    }
  });
}

function fillPropertyTypes(
  swagger: ISwagger,
  typeCollection: ITypeMetaData[],
  options: GeneratorOptions,
  suffix: string,
  fileSuffix: string,
) {
  forEach(typeCollection, (type, typeKey) => {
    forEach(type.properties, (property, propertyKey) => {
      const propertyType = TypeHelpers.findTypeInTypeCollection(typeCollection, property.typeName);
      property.type = propertyType;
    });
  });
}

function generateTSModels(namespaceGroups: INamespaceGroups, folder: string, options: GeneratorOptions) {
  const data = {
    generateClasses: options.generateClasses,
    hasComplexType: false,
    validatorFileName: removeExtension(options.validatorsFileName),
    baseModelFileName: removeExtension(options.baseModelFileName),
    subTypeFactoryFileName: removeExtension(options.subTypeFactoryFileName),
    moduleName: options.modelModuleName,
    enumModuleName: options.enumModuleName,
    enumRef: options.enumRef,
    subTypePropertyName: options.subTypePropertyName,
    subTypePropertyConstantName: snakeCase(options.subTypePropertyName).toUpperCase(),
    type: {},
  };
  const template = readAndCompileTemplateFile(options.templates.models);
  ensureFolder(folder);
  for (const namespace in namespaceGroups) {
    if (namespaceGroups[namespace]) {
      const typeCol = namespaceGroups[namespace];
      const firstType =
        typeCol[0] ||
        ({
          namespace: '',
        } as ITypeMetaData);
      const namespacePath = convertNamespaceToPath(firstType.namespace);
      const typeFolder = `${folder}${namespacePath}`;
      const folderParts = namespacePath.split('/');
      let prevParts = folder;
      folderParts.forEach(part => {
        prevParts += part + '/';
        ensureFolder(prevParts);
      });

      let nrGeneratedFiles = 0;
      each(typeCol, type => {
        const outputFileName = join(typeFolder, type.fileName);
        data.type = type;
        data.hasComplexType = type.properties.some(property => property.isComplexType);
        let result: string = '';
        try {
          result = template(data);
        } catch (x) {
          console.error(`Error generating ${outputFileName}, this is likely an issue with the template`);
          console.error(`HandleBar file: ${options.templates.models}`);
          console.error(x);
          throw x;
        }
        const isChanged = writeFileIfContentsIsChanged(outputFileName, result);
        if (isChanged) {
          nrGeneratedFiles++;
        }
        // fs.writeFileSync(outputFileName, result, { flag: 'w', encoding: utils.ENCODING });
      });
      log(`generated ${nrGeneratedFiles} type${nrGeneratedFiles === 1 ? '' : 's'} in ${typeFolder}`);
      removeFilesOfNonExistingTypes(typeCol, typeFolder, options, MODEL_FILE_SUFFIX);
    }
  }
  const namespacePaths = Object.keys(namespaceGroups).map(namespace => {
    return join(folder, convertNamespaceToPath(namespace));
  });
  cleanFoldersForObsoleteFiles(folder, namespacePaths);
}

function generateFormGroupFactories(namespaceGroups: INamespaceGroups, folder: string, options: GeneratorOptions) {
  const data = {
    type: {} as ITypeMetaData,
    hasComplexType: false,
  };
  const template = readAndCompileTemplateFile(options.templates.formGroupFacTemplate);
  ensureFolder(folder);
  for (const namespace in namespaceGroups) {
    if (namespaceGroups[namespace]) {
      const typeCol = namespaceGroups[namespace];
      const firstType =
        typeCol[0] ||
        ({
          namespace: '',
        } as ITypeMetaData);
      const namespacePath = convertNamespaceToPath(firstType.namespace);
      const typeFolder = `${folder}${namespacePath}`;
      const folderParts = namespacePath.split('/');
      let prevParts = folder;
      folderParts.forEach(part => {
        prevParts += part + '/';
        ensureFolder(prevParts);
      });

      let nrGeneratedFiles = 0;
      const exclusionProperties = ['createdBy', 'createdOnUtc', 'updatedBy', 'updatedOnUtc'];
      each(typeCol, type => {
        const outputFileName = join(typeFolder, `${kebabCase(type.fullTypeName)}.form-group-fac.ts`);
        data.type = { ...type, properties: type.properties.filter(prop => !exclusionProperties.includes(prop.name)) };
        data.hasComplexType = type.properties.some(property => property.isComplexType);
        let result: string = '';
        try {
          result = template(data);
        } catch (x) {
          console.error(`Error generating ${outputFileName}, this is likely an issue with the template`);
          console.error(`HandleBar file: ${options.templates.models}`);
          console.error(x);
          throw x;
        }
        const isChanged = writeFileIfContentsIsChanged(outputFileName, result);
        if (isChanged) {
          nrGeneratedFiles++;
        }
        // fs.writeFileSync(outputFileName, result, { flag: 'w', encoding: utils.ENCODING });
      });
      log(`generated ${nrGeneratedFiles} type${nrGeneratedFiles === 1 ? '' : 's'} in ${typeFolder}`);
      removeFilesOfNonExistingTypes(typeCol, typeFolder, options, MODEL_FILE_SUFFIX);
    }
  }
  const namespacePaths = Object.keys(namespaceGroups).map(namespace => {
    return join(folder, convertNamespaceToPath(namespace));
  });
  cleanFoldersForObsoleteFiles(folder, namespacePaths);
}

function cleanFoldersForObsoleteFiles(folder: string, namespacePaths: string[]) {
  getDirectories(folder).forEach(name => {
    const folderPath = join(folder, name);
    const namespacePath = find(namespacePaths, path => {
      return path.startsWith(folderPath);
    });
    if (!namespacePath) {
      removeFolder(folderPath);
      log(`removed obsolete folder ${name} in ${folder}`);
    } else {
      cleanFoldersForObsoleteFiles(folderPath, namespacePaths);
    }
  });
}

function generateSubTypeFactory(namespaceGroups: INamespaceGroups, folder: string, options: GeneratorOptions) {
  const data = {
    subTypes: {},
    subTypePropertyName: options.subTypePropertyName,
  };
  const template = readAndCompileTemplateFile(options.templates.subTypeFactory);
  for (const key in namespaceGroups) {
    if (namespaceGroups[key]) {
      data.subTypes = namespaceGroups[key].filter(type => {
        return type.hasSubTypeProperty;
      });
      const namespacePath = namespaceGroups[key][0] ? namespaceGroups[key][0].path : '';
      const outputFileName = join(folder, options.subTypeFactoryFileName);

      const result = template(data);
      const isChanged = writeFileIfContentsIsChanged(outputFileName, result);
      if (isChanged) {
        log(`generated ${outputFileName}`);
      }
    }
  }
}

function generateBarrelFiles(namespaceGroups: INamespaceGroups, folder: string, options: GeneratorOptions) {
  const data: { fileNames: string[] } = {
    fileNames: [],
  };
  const template = readAndCompileTemplateFile(options.templates.barrel);

  for (const key in namespaceGroups) {
    if (namespaceGroups[key]) {
      data.fileNames = namespaceGroups[key].map(type => {
        return removeExtension(type.fileName);
      });
      namespaceGroups[key].forEach(type => data.fileNames.push(`${kebabCase(type.fullTypeName)}.form-group-fac`));
      if (key === ROOT_NAMESPACE) {
        addRootFixedFileNames(data.fileNames, options);
      }
      const namespacePath = namespaceGroups[key][0] ? namespaceGroups[key][0].path : '';
      const outputFileName = join(folder + namespacePath, 'index.ts');

      const result = template(data);
      const isChanged = writeFileIfContentsIsChanged(outputFileName, result);
      if (isChanged) {
        log(`generated ${outputFileName}`);
      }
    }
  }
}

function addRootFixedFileNames(fileNames: string[], options: GeneratorOptions) {
  const enumOutputFileName = normalize(options.enumTSFile.split('/').pop() || '.');
  if (enumOutputFileName && enumOutputFileName !== '.') {
    fileNames.splice(0, 0, removeExtension(enumOutputFileName));
    if (options.generateValidatorFile) {
      const validatorsOutputFileName = normalize(options.validatorsFileName);
      fileNames.splice(0, 0, removeExtension(validatorsOutputFileName));
    }
  }
}

function removeFilesOfNonExistingTypes(
  typeCollection: ITypeMetaData[],
  folder: string,
  options: GeneratorOptions,
  suffix: string,
) {
  // remove files of types which are no longer defined in typeCollection
  let counter = 0;
  const files = readdirSync(folder);
  each(files, file => {
    if (
      endsWith(file, suffix) &&
      !find(typeCollection, type => {
        return type.fileName === file;
      })
    ) {
      counter++;
      unlinkSync(join(folder, file));
      log(`removed ${file} in ${folder}`);
    }
  });
  if (counter > 0) {
    log(`removed ${counter} types in ${folder}`);
  }
}
