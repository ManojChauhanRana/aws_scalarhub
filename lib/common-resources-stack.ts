// Import necessary modules from the AWS Cloud Development Kit (CDK) library
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
// Import the Construct class from 'constructs' module
import { Construct } from 'constructs';
// Import the DynamoDB namespace from the AWS CDK DynamoDB module
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

// Define an interface extending StackProps to hold props specific to CommonResourcesStack
export interface CommonResourcesStackProps extends StackProps {
}

// Define the CommonResourcesStack class which extends Stack
export class CommonResourcesStack extends Stack {
    // Constructor method for CommonResourcesStack
    constructor(scope: Construct, id: string, props: CommonResourcesStackProps) {
        // Call the constructor of the base class (Stack)
        super(scope, id, props);

        // Call methods to create DynamoDB tables
        this.createPooledDynamoTables();
        this.createCommonDynamoTables();
    }

    // Method to create a DynamoDB table for tenant-related data
    private createCommonDynamoTables(): void {
        // Create a DynamoDB table named 'TenantTable'
        const tenantTable = new dynamodb.Table(this, 'TenantTable', {
            // Define table name
            tableName: "Tenant",
            // Define partition key for the table
            partitionKey: {
                name: "TENANT_ID", // Partition key name
                type: dynamodb.AttributeType.STRING // Partition key type
            },
            // Define read capacity units
            readCapacity: 5,
            // Define write capacity units
            writeCapacity: 5,
            // Specify removal policy
            removalPolicy: RemovalPolicy.DESTROY // Delete the table when stack is deleted
        });
    }

    // Method to create a DynamoDB table for product-related data
    private createPooledDynamoTables(): void {
        // Create a DynamoDB table named 'ProductsTable'
        new dynamodb.Table(this, 'ProductsTable', {
            // Define table name
            tableName: "Product",
            // Define partition key for the table
            partitionKey: {
                name: "TenantId", // Partition key name
                type: dynamodb.AttributeType.STRING // Partition key type
            },
            // Define sort key for the table
            sortKey: {
                name: "ProductId", // Sort key name
                type: dynamodb.AttributeType.STRING // Sort key type
            },
            // Define read capacity units
            readCapacity: 5,
            // Define write capacity units
            writeCapacity: 5,
            // Specify removal policy
            removalPolicy: RemovalPolicy.DESTROY // Delete the table when stack is deleted
        });
    }
}
