//! Isolated Slint/wgpu bridge. Frames stay on the shared GPU device.
use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3};
use slint::wgpu_30::wgpu::{self, util::DeviceExt};
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Vertex {
    position: [f32; 3],
    uv: [f32; 2],
    normal: [f32; 3],
    bone: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniform {
    camera: [[f32; 4]; 4],
    bones: [[[f32; 4]; 4]; 6],
}
#[derive(Clone)]
pub struct Skin {
    pub pixels: Vec<u8>,
    pub slim: bool,
}
impl Skin {
    pub fn decode(url: &str, slim: bool) -> Result<Self, Box<dyn std::error::Error>> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.split_once(',').ok_or("Invalid skin")?.1)?;
        let image = image::load_from_memory(&bytes)?.to_rgba8();
        if image.width() != 64 || ![32, 64].contains(&image.height()) {
            return Err("Skin must be 64×32 or 64×64".into());
        }
        let mut atlas = image::RgbaImage::new(64, 64);
        image::imageops::replace(&mut atlas, &image, 0, 0);
        if image.height() == 32 {
            // Legacy skins use mirrored right limbs for both sides.
            for (sx, sy, dx, dy, w, h) in [(0, 16, 16, 48, 16, 16), (40, 16, 32, 48, 16, 16)] {
                let limb = image::imageops::crop_imm(&image, sx, sy, w, h).to_image();
                image::imageops::replace(&mut atlas, &limb, dx, dy);
            }
        }
        // Old skin exports sometimes include transparent base-layer pixels.
        for y in 0..32 {
            for x in 0..64 {
                if y < 16 && x >= 32 {
                    continue;
                }
                atlas.get_pixel_mut(x, y).0[3] = 255;
            }
        }
        Ok(Self {
            pixels: atlas.into_raw(),
            slim,
        })
    }
    pub fn fallback() -> Self {
        let mut pixels = vec![0u8; 64 * 64 * 4];
        for y in 0..64 {
            for x in 0..64 {
                let color = if y < 16 && x < 32 {
                    [177, 124, 87, 255]
                } else if y < 32 && x < 16 {
                    [54, 59, 110, 255]
                } else if y < 32 && x < 40 {
                    [32, 167, 170, 255]
                } else if y < 32 {
                    [177, 124, 87, 255]
                } else {
                    [0, 0, 0, 0]
                };
                let i = (y * 64 + x) * 4;
                pixels[i..i + 4].copy_from_slice(&color);
            }
        }
        Self {
            pixels,
            slim: false,
        }
    }
}
pub struct Scene {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    bind: wgpu::BindGroup,
    vertex: wgpu::Buffer,
    count: u32,
    uniform: wgpu::Buffer,
    pub texture: wgpu::Texture,
    depth: wgpu::Texture,
    pub width: u32,
    pub height: u32,
}
const SHADER: &str = r#"
struct Uniforms { camera:mat4x4<f32>, bones:array<mat4x4<f32>,6> }
@group(0) @binding(0) var<uniform> u:Uniforms;
@group(0) @binding(1) var skin:texture_2d<f32>;
@group(0) @binding(2) var sampler_skin:sampler;
struct Output { @builtin(position) position:vec4<f32>, @location(0) uv:vec2<f32>, @location(1) normal:vec3<f32> }
@vertex fn vs(@location(0) p:vec3<f32>,@location(1) uv:vec2<f32>,@location(2) n:vec3<f32>,@location(3) bone:u32)->Output {
    var o:Output; let model=u.bones[bone]; o.position=u.camera*model*vec4(p,1);o.uv=uv;o.normal=(model*vec4(n,0)).xyz;return o;
}
@fragment fn fs(o:Output)->@location(0) vec4<f32> {
    let c=textureSample(skin,sampler_skin,o.uv); if c.a<0.1 {discard;}
    let light=0.55+0.45*max(dot(normalize(o.normal),normalize(vec3(-0.4,0.8,0.6))),0.0);
    return vec4(c.rgb*light*c.a,c.a);
}"#;
fn texture(device: &wgpu::Device, width: u32, height: u32, depth: bool) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("SLH character target"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: if depth {
            wgpu::TextureFormat::Depth32Float
        } else {
            wgpu::TextureFormat::Rgba8Unorm
        },
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}
fn cuboid(out: &mut Vec<Vertex>, center: Vec3, size: Vec3, uv: [f32; 2], bone: u32, inflate: f32) {
    let [w, h, d] = size.to_array();
    let [x, y] = uv;
    let uv_rects = [
        [x + d, y + d, w, h],
        [x + d + w + d, y + d, w, h],
        [x, y + d, d, h],
        [x + d + w, y + d, d, h],
        [x + d, y, w, d],
        [x + d + w, y, w, d],
    ];
    let faces = [
        (
            [0., 0., 1.],
            [[-1., 1., 1.], [-1., -1., 1.], [1., -1., 1.], [1., 1., 1.]],
        ),
        (
            [0., 0., -1.],
            [
                [1., 1., -1.],
                [1., -1., -1.],
                [-1., -1., -1.],
                [-1., 1., -1.],
            ],
        ),
        (
            [-1., 0., 0.],
            [
                [-1., 1., -1.],
                [-1., -1., -1.],
                [-1., -1., 1.],
                [-1., 1., 1.],
            ],
        ),
        (
            [1., 0., 0.],
            [[1., 1., 1.], [1., -1., 1.], [1., -1., -1.], [1., 1., -1.]],
        ),
        (
            [0., 1., 0.],
            [[-1., 1., -1.], [-1., 1., 1.], [1., 1., 1.], [1., 1., -1.]],
        ),
        (
            [0., -1., 0.],
            [
                [-1., -1., 1.],
                [-1., -1., -1.],
                [1., -1., -1.],
                [1., -1., 1.],
            ],
        ),
    ];
    for (face, rect) in faces.iter().zip(uv_rects) {
        let [u, v, uw, vh] = rect;
        let coords = [[u, v], [u, v + vh], [u + uw, v + vh], [u + uw, v]];
        for index in [0, 1, 2, 0, 2, 3] {
            let pos =
                center + Vec3::from_array(face.1[index]) * (size * 0.5 + Vec3::splat(inflate));
            out.push(Vertex {
                position: pos.to_array(),
                uv: [coords[index][0] / 64., coords[index][1] / 64.],
                normal: face.0,
                bone,
            });
        }
    }
}
impl Scene {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        skin: &Skin,
        width: u32,
        height: u32,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("SLH skin shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: std::mem::size_of::<Uniform>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let atlas = device.create_texture_with_data(
            queue,
            &wgpu::TextureDescriptor {
                label: Some("64×64 skin atlas"),
                size: wgpu::Extent3d {
                    width: 64,
                    height: 64,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::default(),
            &skin.pixels,
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let view = atlas.create_view(&Default::default());
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        const ATTRS: [wgpu::VertexAttribute; 4] =
            wgpu::vertex_attr_array![0=>Float32x3,1=>Float32x2,2=>Float32x3,3=>Uint32];
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("SLH native skin"),
            layout: Some(&pl),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<Vertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &ATTRS,
                })],
            },
            primitive: wgpu::PrimitiveState {
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth32Float,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let mut vertices = Vec::new();
        let arm = if skin.slim { 3. } else { 4. };
        let parts = [
            (
                Vec3::new(0., 12., 0.),
                Vec3::new(8., 8., 8.),
                [0., 0.],
                [32., 0.],
                0,
            ),
            (
                Vec3::new(0., 2., 0.),
                Vec3::new(8., 12., 4.),
                [16., 16.],
                [16., 32.],
                1,
            ),
            (
                Vec3::new(-4. - arm / 2., 2., 0.),
                Vec3::new(arm, 12., 4.),
                [40., 16.],
                [40., 32.],
                2,
            ),
            (
                Vec3::new(4. + arm / 2., 2., 0.),
                Vec3::new(arm, 12., 4.),
                [32., 48.],
                [48., 48.],
                3,
            ),
            (
                Vec3::new(-2., -10., 0.),
                Vec3::new(4., 12., 4.),
                [0., 16.],
                [0., 32.],
                4,
            ),
            (
                Vec3::new(2., -10., 0.),
                Vec3::new(4., 12., 4.),
                [16., 48.],
                [0., 48.],
                5,
            ),
        ];
        for (center, size, base, outer, bone) in parts {
            cuboid(&mut vertices, center, size, base, bone, 0.);
            cuboid(
                &mut vertices,
                center,
                size,
                outer,
                bone,
                if bone == 0 { 0.5 } else { 0.25 },
            );
        }
        let vertex = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });
        Self {
            device: device.clone(),
            queue: queue.clone(),
            pipeline,
            bind,
            vertex,
            count: vertices.len() as u32,
            uniform,
            texture: texture(device, width, height, false),
            depth: texture(device, width, height, true),
            width,
            height,
        }
    }
    pub fn resize(&mut self, width: u32, height: u32) {
        if (width, height) != (self.width, self.height) {
            self.texture = texture(&self.device, width, height, false);
            self.depth = texture(&self.device, width, height, true);
            self.width = width;
            self.height = height;
        }
    }
    pub fn render(&self, yaw: f32, pitch: f32, zoom: f32, idle_time: Option<f32>) {
        let angle = yaw + 0.35;
        let aspect = self.width as f32 / self.height as f32;
        let distance = 57. / zoom * (0.42 / aspect).max(1.0);
        let eye = Vec3::new(
            angle.sin() * distance,
            pitch.sin() * distance + 3.,
            angle.cos() * distance,
        );
        let camera = Mat4::perspective_rh(
            42f32.to_radians(),
            self.width as f32 / self.height as f32,
            0.1,
            250.,
        ) * Mat4::look_at_rh(eye, Vec3::ZERO, Vec3::Y);
        let mut bones = [Mat4::IDENTITY; 6];
        if let Some(t) = idle_time {
            let tilt = (t * 1.4).sin() * 0.045;
            for (i, x) in [(2, -6.), (3, 6.)] {
                bones[i] = Mat4::from_translation(Vec3::new(x, 8., 0.))
                    * Mat4::from_rotation_z(if i == 2 { -tilt - 0.035 } else { tilt + 0.035 })
                    * Mat4::from_translation(Vec3::new(-x, -8., 0.));
            }
            bones[0] = Mat4::from_rotation_y((t * 0.45).sin() * 0.025);
        }
        self.queue.write_buffer(
            &self.uniform,
            0,
            bytemuck::bytes_of(&Uniform {
                camera: camera.to_cols_array_2d(),
                bones: bones.map(|m| m.to_cols_array_2d()),
            }),
        );
        let view = self.texture.create_view(&Default::default());
        let depth = self.depth.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth,
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.),
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind, &[]);
            pass.set_vertex_buffer(0, self.vertex.slice(..));
            pass.draw(0..self.count, 0..1);
        }
        self.queue.submit([encoder.finish()]);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometry_is_bounded_and_texture_coordinates_fit() {
        let mut v = Vec::new();
        cuboid(
            &mut v,
            Vec3::ZERO,
            Vec3::new(8., 12., 4.),
            [16., 16.],
            1,
            0.,
        );
        assert_eq!(v.len(), 36);
        assert!(
            v.iter()
                .all(|v| v.uv.iter().all(|x| (0.0..=1.0).contains(x)))
        );
    }
    #[test]
    fn invalid_skin_is_rejected() {
        assert!(Skin::decode("bad", false).is_err());
    }
}
