terraform {
  required_version = ">= 1.5.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 7.0.0, < 9.0.0"
    }
  }
}

provider "oci" {
  region = var.region
}

variable "tenancy_ocid" { type = string }
variable "compartment_ocid" { type = string }
variable "region" { type = string }
variable "ssh_public_key" {
  type = string
  validation {
    condition     = can(regex("^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+", trimspace(var.ssh_public_key)))
    error_message = "Supply a public SSH key. Never supply the private key."
  }
}
variable "ssh_source_cidr" {
  type    = string
  default = "0.0.0.0/0"
}
variable "ocpus" {
  type    = number
  default = 2
  validation {
    condition     = var.ocpus >= 1 && var.ocpus <= 2
    error_message = "This template is limited to 2 A1 OCPUs. Check your tenancy's total Always Free allocation."
  }
}
variable "memory_gbs" {
  type    = number
  default = 12
  validation {
    condition     = var.memory_gbs >= 2 && var.memory_gbs <= 12
    error_message = "This template is limited to 12 GB RAM. Existing A1 machines count toward the same allowance."
  }
}
variable "boot_volume_gbs" {
  type    = number
  default = 50
  validation {
    condition     = var.boot_volume_gbs >= 50 && var.boot_volume_gbs <= 100
    error_message = "Use a 50–100 GB boot volume; all tenancy boot/block volumes share the free allowance."
  }
}
variable "availability_domain_index" {
  type    = number
  default = 0
}

data "oci_identity_availability_domains" "home" {
  compartment_id = var.tenancy_ocid
}
data "oci_core_images" "ubuntu" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}
resource "oci_core_vcn" "vault" {
  compartment_id = var.compartment_ocid
  cidr_block     = "10.74.0.0/24"
  display_name   = "mediavault"
  dns_label      = "mediavault"
}
resource "oci_core_internet_gateway" "vault" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vault.id
  display_name   = "mediavault-internet"
  enabled        = true
}
resource "oci_core_route_table" "vault" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vault.id
  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.vault.id
  }
}
resource "oci_core_security_list" "vault" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vault.id
  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }
  dynamic "ingress_security_rules" {
    for_each = { ssh = 22, http = 80, https = 443 }
    content {
      protocol = "6"
      source   = ingress_security_rules.key == "ssh" ? var.ssh_source_cidr : "0.0.0.0/0"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }
}
resource "oci_core_subnet" "vault" {
  compartment_id             = var.compartment_ocid
  vcn_id                     = oci_core_vcn.vault.id
  cidr_block                 = "10.74.0.0/24"
  display_name               = "mediavault-public"
  dns_label                  = "public"
  route_table_id             = oci_core_route_table.vault.id
  security_list_ids          = [oci_core_security_list.vault.id]
  prohibit_public_ip_on_vnic = false
}
resource "oci_core_instance" "vault" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.home.availability_domains[var.availability_domain_index].name
  display_name        = "mediavault-import"
  shape               = "VM.Standard.A1.Flex"
  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gbs
  }
  create_vnic_details {
    subnet_id        = oci_core_subnet.vault.id
    assign_public_ip = true
    display_name     = "mediavault-public"
  }
  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gbs
  }
  metadata = {
    ssh_authorized_keys = trimspace(var.ssh_public_key)
    user_data           = base64encode(file("${path.module}/cloud-init.yaml"))
  }
  lifecycle {
    # Protects against accidental Terraform destroy, not Oracle's idle policy.
    prevent_destroy = true
  }
}
output "public_ip" { value = oci_core_instance.vault.public_ip }
output "suggested_hostname" { value = "${oci_core_instance.vault.public_ip}.sslip.io" }
