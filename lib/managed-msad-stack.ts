import {
  Fn,
  Stack,
  StackProps,
  CfnDynamicReference,
  CfnDynamicReferenceService,
  CfnOutput,
  aws_iam as iam,
  aws_ec2 as ec2,
  aws_secretsmanager as secretsmanager,
  aws_directoryservice as directoryservice,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export class AddsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const managedMSADDomainName = "managed-msad.non-97.net";
    const ec2ADDSDomainName = "corp.non-97.net";

    // EC2 Instance IAM Role
    const ec2InstanceIAMRole = new iam.Role(this, "EC2 Instance IAM Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMDirectoryServiceAccess"
        ),
      ],
    });

    // AWS management console login IAM Role
    new iam.Role(this, "AWS management console login IAM Role", {
      assumedBy: new iam.ServicePrincipal("ds.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEC2ReadOnlyAccess"),
      ],
    });

    // VPC
    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.1.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 26,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 26,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 26,
        },
      ],
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,
        },
      },
    });

    // Secret of Managed Microsoft AD
    const managedMSADSecret = new secretsmanager.Secret(
      this,
      "Secret of Managed Microsoft AD",
      {
        secretName: `/managedMSAD/${managedMSADDomainName}/Admin`,
        generateSecretString: {
          generateStringKey: "password",
          passwordLength: 32,
          requireEachIncludedType: true,
          secretStringTemplate: '{"userName": "Admin"}',
        },
      }
    );

    // Managed Microsoft AD
    const managedMSAD = new directoryservice.CfnMicrosoftAD(
      this,
      "Managed Microsoft AD",
      {
        name: managedMSADDomainName,
        password: new CfnDynamicReference(
          CfnDynamicReferenceService.SECRETS_MANAGER,
          `${managedMSADSecret.secretArn}:SecretString:password`
        ).toString(),
        vpcSettings: {
          subnetIds: vpc.selectSubnets({
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          }).subnetIds,
          vpcId: vpc.vpcId,
        },
        createAlias: true,
        edition: "Standard",
        enableSso: false,
      }
    );

    // DHCP Options
    const dhcpOptions = new ec2.CfnDHCPOptions(this, "DHCP Options", {
      domainName: managedMSAD.name,
      domainNameServers: managedMSAD.attrDnsIpAddresses,
    });

    new ec2.CfnVPCDHCPOptionsAssociation(this, "VPC DHCP Options Association", {
      dhcpOptionsId: dhcpOptions.ref,
      vpcId: vpc.vpcId,
    });

    // EC2 Instance
    const instance = new ec2.Instance(this, "EC2 Instance", {
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestWindows(
        ec2.WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE
      ),
      vpc,
      blockDevices: [
        {
          deviceName: "/dev/sda1",
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      role: ec2InstanceIAMRole,
    });

    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;

    // Join directory service domain
    cfnInstance.ssmAssociations = [
      {
        documentName: "AWS-JoinDirectoryServiceDomain",
        associationParameters: [
          {
            key: "directoryId",
            value: [managedMSAD.ref],
          },
          {
            key: "directoryName",
            value: [managedMSAD.name],
          },
        ],
      },
    ];
  }
  }
}
