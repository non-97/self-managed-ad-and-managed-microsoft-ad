import {
  Fn,
  Stack,
  StackProps,
  CfnDynamicReference,
  CfnDynamicReferenceService,
  aws_iam as iam,
  aws_ec2 as ec2,
  aws_secretsmanager as secretsmanager,
  aws_directoryservice as directoryservice,
  aws_route53resolver as route53resolver,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export class AddsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const managedMSADDomainName = "managed-msad.non-97.net";
    const selfManagedADDomainName = "corp.non-97.net";

    // EC2 Instance IAM Role
    const ec2InstanceIAMRole = new iam.Role(this, "EC2 Instance IAM Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // VPC
    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.1.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 27,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 27,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 27,
        },
      ],
    });

    // Security Group
    const resolverEndpointSG = new ec2.SecurityGroup(
      this,
      "Resolver Endpoint SG",
      {
        vpc,
      }
    );
    resolverEndpointSG.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(53)
    );
    resolverEndpointSG.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.udp(53)
    );

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

    // EC2 Instance
    const selfManagedADInstance = new ec2.Instance(
      this,
      "Self Managed AD EC2 Instance",
      {
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
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }),
        role: ec2InstanceIAMRole,
      }
    );

    const managedMSADClient = new ec2.Instance(
      this,
      "Managed Microsoft AD Client",
      {
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
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }),
        role: ec2InstanceIAMRole,
      }
    );

    // Route 53 Resolver
    const resolverEndpoint = new route53resolver.CfnResolverEndpoint(
      this,
      "Resolver Endpoint",
      {
        direction: "OUTBOUND",
        ipAddresses: vpc
          .selectSubnets({
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          })
          .subnetIds.map((subnetId) => {
            return { subnetId: subnetId };
          }),
        securityGroupIds: [resolverEndpointSG.securityGroupId],
      }
    );

    const managedMicrosoftADResolverRule = new route53resolver.CfnResolverRule(
      this,
      "Managed Microsoft AD Resolver Rule",
      {
        domainName: managedMSADDomainName,
        ruleType: "FORWARD",
        resolverEndpointId: resolverEndpoint.ref,
        targetIps: managedMSAD.attrDnsIpAddresses.map(
          (IPAddress, index, IPAddresses) => {
            return { ip: Fn.select(index, IPAddresses) };
          }
        ),
      }
    );

    const selfManagedADResolverRule = new route53resolver.CfnResolverRule(
      this,
      "Self Managed AD Resolver Rule",
      {
        domainName: selfManagedADDomainName,
        ruleType: "FORWARD",
        resolverEndpointId: resolverEndpoint.ref,
        targetIps: [{ ip: selfManagedADInstance.instancePrivateIp }],
      }
    );

    new route53resolver.CfnResolverRuleAssociation(
      this,
      "Managed Microsoft AD Resolver Rule Association",
      {
        resolverRuleId: managedMicrosoftADResolverRule.ref,
        vpcId: vpc.vpcId,
      }
    );

    new route53resolver.CfnResolverRuleAssociation(
      this,
      "Self Managed AD Resolver Rule Association",
      {
        resolverRuleId: selfManagedADResolverRule.ref,
        vpcId: vpc.vpcId,
      }
    );
  }
}
