#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals, dead_code)]
use std::ffi::{c_char, c_void};

pub type TrackedDeviceIndex_t = u32;
pub type VROverlayHandle_t = u64;
pub type PropertyTypeTag_t = u32;
pub type TextureID_t = i32;
pub type glUInt_t = u32;
pub type VRActionHandle_t = u64;
pub type VRActionSetHandle_t = u64;
pub type VRInputValueHandle_t = u64;

pub const k_unTrackedDeviceIndex_Hmd: u32 = 0;
pub const k_unMaxTrackedDeviceCount: u32 = 64;
pub const k_unTrackedDeviceIndexInvalid: u32 = 4294967295;
pub const k_unVROverlayMaxKeyLength: u32 = 128;
pub const k_unVROverlayMaxNameLength: u32 = 128;
pub const k_unMaxOverlayCount: u32 = 128;
pub const k_ulOverlayHandleInvalid: u64 = 0;
pub const k_ulInvalidActionHandle: u64 = 0;
pub const k_ulInvalidActionSetHandle: u64 = 0;
pub const k_ulInvalidInputValueHandle: u64 = 0;
pub const IVRSystem_Version: &str = "IVRSystem_026";
pub const IVRSystem_FnTable: &[u8] = b"FnTable:IVRSystem_026\0";
pub const IVRCompositor_Version: &str = "IVRCompositor_029";
pub const IVRCompositor_FnTable: &[u8] = b"FnTable:IVRCompositor_029\0";
pub const IVROverlay_Version: &str = "IVROverlay_028";
pub const IVROverlay_FnTable: &[u8] = b"FnTable:IVROverlay_028\0";
pub const IVRChaperone_Version: &str = "IVRChaperone_004";
pub const IVRChaperone_FnTable: &[u8] = b"FnTable:IVRChaperone_004\0";
pub const IVRInput_Version: &str = "IVRInput_011";
pub const IVRInput_FnTable: &[u8] = b"FnTable:IVRInput_011\0";
pub const IVRApplications_Version: &str = "IVRApplications_008";
pub const IVRApplications_FnTable: &[u8] = b"FnTable:IVRApplications_008\0";

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct HmdMatrix34_t {
    pub m: [[f32; 4]; 3],
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct HmdMatrix44_t {
    pub m: [[f32; 4]; 4],
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct HmdVector3_t {
    pub v: [f32; 3],
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct HmdVector2_t {
    pub v: [f32; 2],
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct HmdColor_t {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct HmdRect2_t {
    pub vTopLeft: HmdVector2_t,
    pub vBottomRight: HmdVector2_t,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct HmdQuad_t {
    pub vCorners: [HmdVector3_t; 4],
}

#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct HiddenAreaMesh_t {
    pub pVertexData: *mut HmdVector2_t,
    pub unTriangleCount: u32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct TrackedDevicePose_t {
    pub mDeviceToAbsoluteTracking: HmdMatrix34_t,
    pub vVelocity: HmdVector3_t,
    pub vAngularVelocity: HmdVector3_t,
    pub eTrackingResult: ETrackingResult,
    pub bPoseIsValid: bool,
    pub bDeviceIsConnected: bool,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct Compositor_FrameTiming {
    pub m_nSize: u32,
    pub m_nFrameIndex: u32,
    pub m_nNumFramePresents: u32,
    pub m_nNumMisPresented: u32,
    pub m_nNumDroppedFrames: u32,
    pub m_nReprojectionFlags: u32,
    pub m_flSystemTimeInSeconds: f64,
    pub m_flPreSubmitGpuMs: f32,
    pub m_flPostSubmitGpuMs: f32,
    pub m_flTotalRenderGpuMs: f32,
    pub m_flCompositorRenderGpuMs: f32,
    pub m_flCompositorRenderCpuMs: f32,
    pub m_flCompositorIdleCpuMs: f32,
    pub m_flClientFrameIntervalMs: f32,
    pub m_flPresentCallCpuMs: f32,
    pub m_flWaitForPresentCpuMs: f32,
    pub m_flSubmitFrameMs: f32,
    pub m_flWaitGetPosesCalledMs: f32,
    pub m_flNewPosesReadyMs: f32,
    pub m_flNewFrameReadyMs: f32,
    pub m_flCompositorUpdateStartMs: f32,
    pub m_flCompositorUpdateEndMs: f32,
    pub m_flCompositorRenderStartMs: f32,
    pub m_HmdPose: TrackedDevicePose_t,
    pub m_nNumVSyncsReadyForUse: u32,
    pub m_nNumVSyncsToFirstView: u32,
    pub m_flTransferLatencyMs: f32,
}

pub const VRCompositor_ReprojectionReason_Cpu: u32 = 0x01;
pub const VRCompositor_ReprojectionReason_Gpu: u32 = 0x02;
pub const VRCompositor_ReprojectionMotion: u32 = 0x08;

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct Compositor_CumulativeStats {
    pub m_nPid: u32,
    pub m_nNumFramePresents: u32,
    pub m_nNumDroppedFrames: u32,
    pub m_nNumReprojectedFrames: u32,
    pub m_nNumFramePresentsOnStartup: u32,
    pub m_nNumDroppedFramesOnStartup: u32,
    pub m_nNumReprojectedFramesOnStartup: u32,
    pub m_nNumLoading: u32,
    pub m_nNumFramePresentsLoading: u32,
    pub m_nNumDroppedFramesLoading: u32,
    pub m_nNumReprojectedFramesLoading: u32,
    pub m_nNumTimedOut: u32,
    pub m_nNumFramePresentsTimedOut: u32,
    pub m_nNumDroppedFramesTimedOut: u32,
    pub m_nNumReprojectedFramesTimedOut: u32,
    pub m_nNumFrameSubmits: u32,
    pub m_flSumCompositorCPUTimeMS: f64,
    pub m_flSumCompositorGPUTimeMS: f64,
    pub m_flSumTargetFrameTimes: f64,
    pub m_flSumApplicationCPUTimeMS: f64,
    pub m_flSumApplicationGPUTimeMS: f64,
    pub m_nNumFramesWithDepth: u32,
}

const _: () = assert!(size_of::<Compositor_FrameTiming>() == 192 && size_of::<Compositor_CumulativeStats>() == 112);

#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct Texture_t {
    pub handle: *mut c_void,
    pub eType: ETextureType,
    pub eColorSpace: EColorSpace,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VRTextureBounds_t {
    pub uMin: f32,
    pub vMin: f32,
    pub uMax: f32,
    pub vMax: f32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_Reserved_t {
    pub reserved0: u64,
    pub reserved1: u64,
    pub reserved2: u64,
    pub reserved3: u64,
    pub reserved4: u64,
    pub reserved5: u64,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_Controller_t {
    pub button: u32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_Mouse_t {
    pub x: f32,
    pub y: f32,
    pub button: u32,
    pub cursorIndex: u32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_Scroll_t {
    pub xdelta: f32,
    pub ydelta: f32,
    pub unused: u32,
    pub viewportscale: f32,
    pub cursorIndex: u32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_Overlay_t {
    pub overlayHandle: u64,
    pub devicePath: u64,
    pub memoryBlockId: u64,
    pub cursorIndex: u32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_Process_t {
    pub pid: u32,
    pub oldPid: u32,
    pub bForced: bool,
    pub bConnectionLost: bool,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_Status_t {
    pub statusState: u32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_Keyboard_t {
    pub cNewInput: [c_char; 8],
    pub uUserValue: u64,
    pub overlayHandle: u64,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VREvent_SeatedZeroPoseReset_t {
    pub bResetBySystemMenu: bool,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct VRActiveActionSet_t {
    pub ulActionSet: VRActionSetHandle_t,
    pub ulRestrictedToDevice: VRInputValueHandle_t,
    pub ulSecondaryActionSet: VRActionSetHandle_t,
    pub unPadding: u32,
    pub nPriority: i32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct InputDigitalActionData_t {
    pub bActive: bool,
    pub activeOrigin: VRInputValueHandle_t,
    pub bState: bool,
    pub bChanged: bool,
    pub fUpdateTime: f32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct InputAnalogActionData_t {
    pub bActive: bool,
    pub activeOrigin: VRInputValueHandle_t,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub deltaX: f32,
    pub deltaY: f32,
    pub deltaZ: f32,
    pub fUpdateTime: f32,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct InputPoseActionData_t {
    pub bActive: bool,
    pub activeOrigin: VRInputValueHandle_t,
    pub pose: TrackedDevicePose_t,
}

#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct InputOriginInfo_t {
    pub devicePath: VRInputValueHandle_t,
    pub trackedDeviceIndex: TrackedDeviceIndex_t,
    pub rchRenderModelComponentName: [c_char; 128],
}

#[repr(C)]
#[derive(Copy, Clone)]
pub union VREvent_Data_t {
    pub reserved: VREvent_Reserved_t,
    pub controller: VREvent_Controller_t,
    pub mouse: VREvent_Mouse_t,
    pub scroll: VREvent_Scroll_t,
    pub process: VREvent_Process_t,
    pub overlay: VREvent_Overlay_t,
    pub status: VREvent_Status_t,
    pub keyboard: VREvent_Keyboard_t,
    pub seatedZeroPoseReset: VREvent_SeatedZeroPoseReset_t,
}

#[repr(C)]
#[derive(Copy, Clone)]
pub struct VREvent_t {
    pub eventType: u32,
    pub trackedDeviceIndex: TrackedDeviceIndex_t,
    pub eventAgeSeconds: f32,
    pub data: VREvent_Data_t,
}

const _: () = assert!(std::mem::size_of::<VREvent_Data_t>() == 48);
const _: () = assert!(std::mem::size_of::<VREvent_t>() == 64);
const _: () = assert!(std::mem::offset_of!(VREvent_t, data) == 16);
const _: () = assert!(std::mem::size_of::<HmdMatrix34_t>() == 48);
const _: () = assert!(std::mem::size_of::<HmdMatrix44_t>() == 64);
const _: () = assert!(std::mem::size_of::<TrackedDevicePose_t>() == 80);
const _: () = assert!(std::mem::size_of::<Texture_t>() == 16);
const _: () = assert!(std::mem::size_of::<VRTextureBounds_t>() == 16);
const _: () = assert!(std::mem::size_of::<VREvent_Mouse_t>() == 16);
const _: () = assert!(std::mem::size_of::<VREvent_Scroll_t>() == 20);
const _: () = assert!(std::mem::size_of::<HmdColor_t>() == 16);
const _: () = assert!(std::mem::size_of::<HiddenAreaMesh_t>() == 16);
const _: () = assert!(std::mem::size_of::<VRActiveActionSet_t>() == 32);
const _: () = assert!(std::mem::size_of::<InputDigitalActionData_t>() == 24);
const _: () = assert!(std::mem::size_of::<InputAnalogActionData_t>() == 48);
const _: () = assert!(std::mem::size_of::<InputPoseActionData_t>() == 96);
const _: () = assert!(std::mem::size_of::<InputOriginInfo_t>() == 144);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct ChaperoneCalibrationState(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EColorSpace(pub i32);
impl EColorSpace {
    pub const ColorSpace_Auto: Self = Self(0);
    pub const ColorSpace_Gamma: Self = Self(1);
    pub const ColorSpace_Linear: Self = Self(2);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EDeviceActivityLevel(pub i32);
impl EDeviceActivityLevel {
    pub const k_EDeviceActivityLevel_Unknown: Self = Self(-1);
    pub const k_EDeviceActivityLevel_Idle: Self = Self(0);
    pub const k_EDeviceActivityLevel_UserInteraction: Self = Self(1);
    pub const k_EDeviceActivityLevel_UserInteraction_Timeout: Self = Self(2);
    pub const k_EDeviceActivityLevel_Standby: Self = Self(3);
    pub const k_EDeviceActivityLevel_Idle_Timeout: Self = Self(4);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EGamepadTextInputLineMode(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EGamepadTextInputMode(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EHiddenAreaMeshType(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct ETextureType(pub i32);
impl ETextureType {
    pub const TextureType_Invalid: Self = Self(-1);
    pub const TextureType_DirectX: Self = Self(0);
    pub const TextureType_OpenGL: Self = Self(1);
    pub const TextureType_Vulkan: Self = Self(2);
    pub const TextureType_IOSurface: Self = Self(3);
    pub const TextureType_DirectX12: Self = Self(4);
    pub const TextureType_DXGISharedHandle: Self = Self(5);
    pub const TextureType_Metal: Self = Self(6);
    pub const TextureType_Reserved: Self = Self(7);
    pub const TextureType_SharedTextureHandle: Self = Self(8);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct ETrackedControllerRole(pub i32);
impl ETrackedControllerRole {
    pub const TrackedControllerRole_Invalid: Self = Self(0);
    pub const TrackedControllerRole_LeftHand: Self = Self(1);
    pub const TrackedControllerRole_RightHand: Self = Self(2);
    pub const TrackedControllerRole_OptOut: Self = Self(3);
    pub const TrackedControllerRole_Treadmill: Self = Self(4);
    pub const TrackedControllerRole_Stylus: Self = Self(5);
    pub const TrackedControllerRole_Max: Self = Self(5);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct ETrackedDeviceClass(pub i32);
impl ETrackedDeviceClass {
    pub const TrackedDeviceClass_Invalid: Self = Self(0);
    pub const TrackedDeviceClass_HMD: Self = Self(1);
    pub const TrackedDeviceClass_Controller: Self = Self(2);
    pub const TrackedDeviceClass_GenericTracker: Self = Self(3);
    pub const TrackedDeviceClass_TrackingReference: Self = Self(4);
    pub const TrackedDeviceClass_DisplayRedirect: Self = Self(5);
    pub const TrackedDeviceClass_Max: Self = Self(6);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct ETrackedDeviceProperty(pub i32);
impl ETrackedDeviceProperty {
    pub const Prop_TrackingSystemName_String: Self = Self(1000);
    pub const Prop_ModelNumber_String: Self = Self(1001);
    pub const Prop_RenderModelName_String: Self = Self(1003);
    pub const Prop_ManufacturerName_String: Self = Self(1005);
    pub const Prop_ActualTrackingSystemName_String: Self = Self(1054);
    pub const Prop_SecondsFromVsyncToPhotons_Float: Self = Self(2001);
    pub const Prop_DisplayFrequency_Float: Self = Self(2002);
    pub const Prop_UserIpdMeters_Float: Self = Self(2003);
    pub const Prop_ControllerType_String: Self = Self(7000);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct ETrackedPropertyError(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct ETrackingResult(pub i32);
impl ETrackingResult {
    pub const TrackingResult_Uninitialized: Self = Self(1);
    pub const TrackingResult_Calibrating_InProgress: Self = Self(100);
    pub const TrackingResult_Calibrating_OutOfRange: Self = Self(101);
    pub const TrackingResult_Running_OK: Self = Self(200);
    pub const TrackingResult_Running_OutOfRange: Self = Self(201);
    pub const TrackingResult_Fallback_RotationOnly: Self = Self(300);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct ETrackingUniverseOrigin(pub i32);
impl ETrackingUniverseOrigin {
    pub const TrackingUniverseSeated: Self = Self(0);
    pub const TrackingUniverseStanding: Self = Self(1);
    pub const TrackingUniverseRawAndUncalibrated: Self = Self(2);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRApplicationError(pub i32);
impl EVRApplicationError {
    pub const VRApplicationError_None: Self = Self(0);
    pub const VRApplicationError_AppKeyAlreadyExists: Self = Self(100);
    pub const VRApplicationError_NoManifest: Self = Self(101);
    pub const VRApplicationError_NoApplication: Self = Self(102);
    pub const VRApplicationError_InvalidIndex: Self = Self(103);
    pub const VRApplicationError_UnknownApplication: Self = Self(104);
    pub const VRApplicationError_IPCFailed: Self = Self(105);
    pub const VRApplicationError_ApplicationAlreadyRunning: Self = Self(106);
    pub const VRApplicationError_InvalidManifest: Self = Self(107);
    pub const VRApplicationError_InvalidApplication: Self = Self(108);
    pub const VRApplicationError_LaunchFailed: Self = Self(109);
    pub const VRApplicationError_ApplicationAlreadyStarting: Self = Self(110);
    pub const VRApplicationError_LaunchInProgress: Self = Self(111);
    pub const VRApplicationError_OldApplicationQuitting: Self = Self(112);
    pub const VRApplicationError_TransitionAborted: Self = Self(113);
    pub const VRApplicationError_IsTemplate: Self = Self(114);
    pub const VRApplicationError_SteamVRIsExiting: Self = Self(115);
    pub const VRApplicationError_WaitingForChaperone: Self = Self(116);
    pub const VRApplicationError_BufferTooSmall: Self = Self(200);
    pub const VRApplicationError_PropertyNotSet: Self = Self(201);
    pub const VRApplicationError_UnknownProperty: Self = Self(202);
    pub const VRApplicationError_InvalidParameter: Self = Self(203);
    pub const VRApplicationError_NotImplemented: Self = Self(300);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRApplicationProperty(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRApplicationType(pub i32);
impl EVRApplicationType {
    pub const VRApplication_Other: Self = Self(0);
    pub const VRApplication_Scene: Self = Self(1);
    pub const VRApplication_Overlay: Self = Self(2);
    pub const VRApplication_Background: Self = Self(3);
    pub const VRApplication_Utility: Self = Self(4);
    pub const VRApplication_VRMonitor: Self = Self(5);
    pub const VRApplication_SteamWatchdog: Self = Self(6);
    pub const VRApplication_Bootstrapper: Self = Self(7);
    pub const VRApplication_WebHelper: Self = Self(8);
    pub const VRApplication_OpenXRInstance: Self = Self(9);
    pub const VRApplication_OpenXRScene: Self = Self(10);
    pub const VRApplication_OpenXROverlay: Self = Self(11);
    pub const VRApplication_Prism: Self = Self(12);
    pub const VRApplication_RoomView: Self = Self(13);
    pub const VRApplication_Max: Self = Self(14);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRButtonId(pub i32);
impl EVRButtonId {
    pub const k_EButton_System: Self = Self(0);
    pub const k_EButton_ApplicationMenu: Self = Self(1);
    pub const k_EButton_Grip: Self = Self(2);
    pub const k_EButton_DPad_Left: Self = Self(3);
    pub const k_EButton_DPad_Up: Self = Self(4);
    pub const k_EButton_DPad_Right: Self = Self(5);
    pub const k_EButton_DPad_Down: Self = Self(6);
    pub const k_EButton_A: Self = Self(7);
    pub const k_EButton_ProximitySensor: Self = Self(31);
    pub const k_EButton_Axis0: Self = Self(32);
    pub const k_EButton_Axis1: Self = Self(33);
    pub const k_EButton_Axis2: Self = Self(34);
    pub const k_EButton_Axis3: Self = Self(35);
    pub const k_EButton_Axis4: Self = Self(36);
    pub const k_EButton_SteamVR_Touchpad: Self = Self(32);
    pub const k_EButton_SteamVR_Trigger: Self = Self(33);
    pub const k_EButton_Dashboard_Back: Self = Self(2);
    pub const k_EButton_IndexController_A: Self = Self(2);
    pub const k_EButton_IndexController_B: Self = Self(1);
    pub const k_EButton_IndexController_JoyStick: Self = Self(35);
    pub const k_EButton_Reserved0: Self = Self(50);
    pub const k_EButton_Reserved1: Self = Self(51);
    pub const k_EButton_Max: Self = Self(64);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRCompositorError(pub i32);
impl EVRCompositorError {
    pub const VRCompositorError_None: Self = Self(0);
    pub const VRCompositorError_RequestFailed: Self = Self(1);
    pub const VRCompositorError_IncompatibleVersion: Self = Self(100);
    pub const VRCompositorError_DoNotHaveFocus: Self = Self(101);
    pub const VRCompositorError_InvalidTexture: Self = Self(102);
    pub const VRCompositorError_IsNotSceneApplication: Self = Self(103);
    pub const VRCompositorError_TextureIsOnWrongDevice: Self = Self(104);
    pub const VRCompositorError_TextureUsesUnsupportedFormat: Self = Self(105);
    pub const VRCompositorError_SharedTexturesNotSupported: Self = Self(106);
    pub const VRCompositorError_IndexOutOfRange: Self = Self(107);
    pub const VRCompositorError_AlreadySubmitted: Self = Self(108);
    pub const VRCompositorError_InvalidBounds: Self = Self(109);
    pub const VRCompositorError_AlreadySet: Self = Self(110);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRCompositorTextureUsage(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRCompositorTimingMode(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRControllerAxisType(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRDistortionChannel(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVREventType(pub i32);
impl EVREventType {
    pub const VREvent_None: Self = Self(0);
    pub const VREvent_TrackedDeviceActivated: Self = Self(100);
    pub const VREvent_TrackedDeviceDeactivated: Self = Self(101);
    pub const VREvent_TrackedDeviceUpdated: Self = Self(102);
    pub const VREvent_TrackedDeviceUserInteractionStarted: Self = Self(103);
    pub const VREvent_TrackedDeviceUserInteractionEnded: Self = Self(104);
    pub const VREvent_IpdChanged: Self = Self(105);
    pub const VREvent_EnterStandbyMode: Self = Self(106);
    pub const VREvent_LeaveStandbyMode: Self = Self(107);
    pub const VREvent_TrackedDeviceRoleChanged: Self = Self(108);
    pub const VREvent_ButtonPress: Self = Self(200);
    pub const VREvent_ButtonUnpress: Self = Self(201);
    pub const VREvent_ButtonTouch: Self = Self(202);
    pub const VREvent_ButtonUntouch: Self = Self(203);
    pub const VREvent_MouseMove: Self = Self(300);
    pub const VREvent_MouseButtonDown: Self = Self(301);
    pub const VREvent_MouseButtonUp: Self = Self(302);
    pub const VREvent_FocusEnter: Self = Self(303);
    pub const VREvent_FocusLeave: Self = Self(304);
    pub const VREvent_ScrollDiscrete: Self = Self(305);
    pub const VREvent_ScrollSmooth: Self = Self(309);
    pub const VREvent_InputFocusChanged: Self = Self(406);
    pub const VREvent_ActionBindingReloaded: Self = Self(409);
    pub const VREvent_SceneApplicationStateChanged: Self = Self(412);
    pub const VREvent_OverlayShown: Self = Self(500);
    pub const VREvent_OverlayHidden: Self = Self(501);
    pub const VREvent_DashboardActivated: Self = Self(502);
    pub const VREvent_DashboardDeactivated: Self = Self(503);
    pub const VREvent_Quit: Self = Self(700);
    pub const VREvent_ProcessQuit: Self = Self(701);
    pub const VREvent_DriverRequestedQuit: Self = Self(704);
    pub const VREvent_ChaperoneUniverseHasChanged: Self = Self(801);
    pub const VREvent_SeatedZeroPoseReset: Self = Self(804);
    pub const VREvent_StandingZeroPoseReset: Self = Self(808);
    pub const VREvent_Input_BindingLoadFailed: Self = Self(1701);
    pub const VREvent_Input_ActionManifestLoadFailed: Self = Self(1704);
    pub const VREvent_Input_BindingsUpdated: Self = Self(1707);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVREye(pub i32);
impl EVREye {
    pub const Eye_Left: Self = Self(0);
    pub const Eye_Right: Self = Self(1);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRFirmwareError(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRInitError(pub i32);
impl EVRInitError {
    pub const VRInitError_None: Self = Self(0);
    pub const VRInitError_Unknown: Self = Self(1);
    pub const VRInitError_Init_InstallationNotFound: Self = Self(100);
    pub const VRInitError_Init_InstallationCorrupt: Self = Self(101);
    pub const VRInitError_Init_VRClientDLLNotFound: Self = Self(102);
    pub const VRInitError_Init_FileNotFound: Self = Self(103);
    pub const VRInitError_Init_FactoryNotFound: Self = Self(104);
    pub const VRInitError_Init_InterfaceNotFound: Self = Self(105);
    pub const VRInitError_Init_InvalidInterface: Self = Self(106);
    pub const VRInitError_Init_UserConfigDirectoryInvalid: Self = Self(107);
    pub const VRInitError_Init_HmdNotFound: Self = Self(108);
    pub const VRInitError_Init_NotInitialized: Self = Self(109);
    pub const VRInitError_Init_PathRegistryNotFound: Self = Self(110);
    pub const VRInitError_Init_NoConfigPath: Self = Self(111);
    pub const VRInitError_Init_NoLogPath: Self = Self(112);
    pub const VRInitError_Init_PathRegistryNotWritable: Self = Self(113);
    pub const VRInitError_Init_AppInfoInitFailed: Self = Self(114);
    pub const VRInitError_Init_Retry: Self = Self(115);
    pub const VRInitError_Init_InitCanceledByUser: Self = Self(116);
    pub const VRInitError_Init_AnotherAppLaunching: Self = Self(117);
    pub const VRInitError_Init_SettingsInitFailed: Self = Self(118);
    pub const VRInitError_Init_ShuttingDown: Self = Self(119);
    pub const VRInitError_Init_TooManyObjects: Self = Self(120);
    pub const VRInitError_Init_NoServerForBackgroundApp: Self = Self(121);
    pub const VRInitError_Init_NotSupportedWithCompositor: Self = Self(122);
    pub const VRInitError_Init_NotAvailableToUtilityApps: Self = Self(123);
    pub const VRInitError_Init_Internal: Self = Self(124);
    pub const VRInitError_Init_HmdDriverIdIsNone: Self = Self(125);
    pub const VRInitError_Init_HmdNotFoundPresenceFailed: Self = Self(126);
    pub const VRInitError_Init_VRMonitorNotFound: Self = Self(127);
    pub const VRInitError_Init_VRMonitorStartupFailed: Self = Self(128);
    pub const VRInitError_Init_LowPowerWatchdogNotSupported: Self = Self(129);
    pub const VRInitError_Init_InvalidApplicationType: Self = Self(130);
    pub const VRInitError_Init_NotAvailableToWatchdogApps: Self = Self(131);
    pub const VRInitError_Init_WatchdogDisabledInSettings: Self = Self(132);
    pub const VRInitError_Init_VRDashboardNotFound: Self = Self(133);
    pub const VRInitError_Init_VRDashboardStartupFailed: Self = Self(134);
    pub const VRInitError_Init_VRHomeNotFound: Self = Self(135);
    pub const VRInitError_Init_VRHomeStartupFailed: Self = Self(136);
    pub const VRInitError_Init_RebootingBusy: Self = Self(137);
    pub const VRInitError_Init_FirmwareUpdateBusy: Self = Self(138);
    pub const VRInitError_Init_FirmwareRecoveryBusy: Self = Self(139);
    pub const VRInitError_Init_USBServiceBusy: Self = Self(140);
    pub const VRInitError_Init_VRWebHelperStartupFailed: Self = Self(141);
    pub const VRInitError_Init_TrackerManagerInitFailed: Self = Self(142);
    pub const VRInitError_Init_AlreadyRunning: Self = Self(143);
    pub const VRInitError_Init_FailedForVrMonitor: Self = Self(144);
    pub const VRInitError_Init_PropertyManagerInitFailed: Self = Self(145);
    pub const VRInitError_Init_WebServerFailed: Self = Self(146);
    pub const VRInitError_Init_IllegalTypeTransition: Self = Self(147);
    pub const VRInitError_Init_MismatchedRuntimes: Self = Self(148);
    pub const VRInitError_Init_InvalidProcessId: Self = Self(149);
    pub const VRInitError_Init_VRServiceStartupFailed: Self = Self(150);
    pub const VRInitError_Init_PrismNeedsNewDrivers: Self = Self(151);
    pub const VRInitError_Init_PrismStartupTimedOut: Self = Self(152);
    pub const VRInitError_Init_CouldNotStartPrism: Self = Self(153);
    pub const VRInitError_Init_PrismClientInitFailed: Self = Self(154);
    pub const VRInitError_Init_PrismClientStartFailed: Self = Self(155);
    pub const VRInitError_Init_PrismExitedUnexpectedly: Self = Self(156);
    pub const VRInitError_Init_BadLuid: Self = Self(157);
    pub const VRInitError_Init_NoServerForAppContainer: Self = Self(158);
    pub const VRInitError_Init_DuplicateBootstrapper: Self = Self(159);
    pub const VRInitError_Init_VRDashboardServicePending: Self = Self(160);
    pub const VRInitError_Init_VRDashboardServiceTimeout: Self = Self(161);
    pub const VRInitError_Init_VRDashboardServiceStopped: Self = Self(162);
    pub const VRInitError_Init_VRDashboardAlreadyStarted: Self = Self(163);
    pub const VRInitError_Init_VRDashboardCopyFailed: Self = Self(164);
    pub const VRInitError_Init_VRDashboardTokenFailure: Self = Self(165);
    pub const VRInitError_Init_VRDashboardEnvironmentFailure: Self = Self(166);
    pub const VRInitError_Init_VRDashboardPathFailure: Self = Self(167);
    pub const VRInitError_Init_InstallationTooOld: Self = Self(168);
    pub const VRInitError_Init_ClientVersionAlreadyProvided: Self = Self(169);
    pub const VRInitError_Driver_Failed: Self = Self(200);
    pub const VRInitError_Driver_Unknown: Self = Self(201);
    pub const VRInitError_Driver_HmdUnknown: Self = Self(202);
    pub const VRInitError_Driver_NotLoaded: Self = Self(203);
    pub const VRInitError_Driver_RuntimeOutOfDate: Self = Self(204);
    pub const VRInitError_Driver_HmdInUse: Self = Self(205);
    pub const VRInitError_Driver_NotCalibrated: Self = Self(206);
    pub const VRInitError_Driver_CalibrationInvalid: Self = Self(207);
    pub const VRInitError_Driver_HmdDisplayNotFound: Self = Self(208);
    pub const VRInitError_Driver_TrackedDeviceInterfaceUnknown: Self = Self(209);
    pub const VRInitError_Driver_HmdDriverIdOutOfBounds: Self = Self(211);
    pub const VRInitError_Driver_HmdDisplayMirrored: Self = Self(212);
    pub const VRInitError_Driver_HmdDisplayNotFoundLaptop: Self = Self(213);
    pub const VRInitError_Driver_PeerDriverNotInstalled: Self = Self(214);
    pub const VRInitError_Driver_WirelessHmdNotConnected: Self = Self(215);
    pub const VRInitError_IPC_ServerInitFailed: Self = Self(300);
    pub const VRInitError_IPC_ConnectFailed: Self = Self(301);
    pub const VRInitError_IPC_SharedStateInitFailed: Self = Self(302);
    pub const VRInitError_IPC_CompositorInitFailed: Self = Self(303);
    pub const VRInitError_IPC_MutexInitFailed: Self = Self(304);
    pub const VRInitError_IPC_Failed: Self = Self(305);
    pub const VRInitError_IPC_CompositorConnectFailed: Self = Self(306);
    pub const VRInitError_IPC_CompositorInvalidConnectResponse: Self = Self(307);
    pub const VRInitError_IPC_ConnectFailedAfterMultipleAttempts: Self = Self(308);
    pub const VRInitError_IPC_ConnectFailedAfterTargetExited: Self = Self(309);
    pub const VRInitError_IPC_NamespaceUnavailable: Self = Self(310);
    pub const VRInitError_Compositor_Failed: Self = Self(400);
    pub const VRInitError_Compositor_D3D11HardwareRequired: Self = Self(401);
    pub const VRInitError_Compositor_FirmwareRequiresUpdate: Self = Self(402);
    pub const VRInitError_Compositor_OverlayInitFailed: Self = Self(403);
    pub const VRInitError_Compositor_ScreenshotsInitFailed: Self = Self(404);
    pub const VRInitError_Compositor_UnableToCreateDevice: Self = Self(405);
    pub const VRInitError_Compositor_SharedStateIsNull: Self = Self(406);
    pub const VRInitError_Compositor_NotificationManagerIsNull: Self = Self(407);
    pub const VRInitError_Compositor_ResourceManagerClientIsNull: Self = Self(408);
    pub const VRInitError_Compositor_MessageOverlaySharedStateInitFailure: Self = Self(409);
    pub const VRInitError_Compositor_PropertiesInterfaceIsNull: Self = Self(410);
    pub const VRInitError_Compositor_CreateFullscreenWindowFailed: Self = Self(411);
    pub const VRInitError_Compositor_SettingsInterfaceIsNull: Self = Self(412);
    pub const VRInitError_Compositor_FailedToShowWindow: Self = Self(413);
    pub const VRInitError_Compositor_DistortInterfaceIsNull: Self = Self(414);
    pub const VRInitError_Compositor_DisplayFrequencyFailure: Self = Self(415);
    pub const VRInitError_Compositor_RendererInitializationFailed: Self = Self(416);
    pub const VRInitError_Compositor_DXGIFactoryInterfaceIsNull: Self = Self(417);
    pub const VRInitError_Compositor_DXGIFactoryCreateFailed: Self = Self(418);
    pub const VRInitError_Compositor_DXGIFactoryQueryFailed: Self = Self(419);
    pub const VRInitError_Compositor_InvalidAdapterDesktop: Self = Self(420);
    pub const VRInitError_Compositor_InvalidHmdAttachment: Self = Self(421);
    pub const VRInitError_Compositor_InvalidOutputDesktop: Self = Self(422);
    pub const VRInitError_Compositor_InvalidDeviceProvided: Self = Self(423);
    pub const VRInitError_Compositor_D3D11RendererInitializationFailed: Self = Self(424);
    pub const VRInitError_Compositor_FailedToFindDisplayMode: Self = Self(425);
    pub const VRInitError_Compositor_FailedToCreateSwapChain: Self = Self(426);
    pub const VRInitError_Compositor_FailedToGetBackBuffer: Self = Self(427);
    pub const VRInitError_Compositor_FailedToCreateRenderTarget: Self = Self(428);
    pub const VRInitError_Compositor_FailedToCreateDXGI2SwapChain: Self = Self(429);
    pub const VRInitError_Compositor_FailedtoGetDXGI2BackBuffer: Self = Self(430);
    pub const VRInitError_Compositor_FailedToCreateDXGI2RenderTarget: Self = Self(431);
    pub const VRInitError_Compositor_FailedToGetDXGIDeviceInterface: Self = Self(432);
    pub const VRInitError_Compositor_SelectDisplayMode: Self = Self(433);
    pub const VRInitError_Compositor_FailedToCreateNvAPIRenderTargets: Self = Self(434);
    pub const VRInitError_Compositor_NvAPISetDisplayMode: Self = Self(435);
    pub const VRInitError_Compositor_FailedToCreateDirectModeDisplay: Self = Self(436);
    pub const VRInitError_Compositor_InvalidHmdPropertyContainer: Self = Self(437);
    pub const VRInitError_Compositor_UpdateDisplayFrequency: Self = Self(438);
    pub const VRInitError_Compositor_CreateRasterizerState: Self = Self(439);
    pub const VRInitError_Compositor_CreateWireframeRasterizerState: Self = Self(440);
    pub const VRInitError_Compositor_CreateSamplerState: Self = Self(441);
    pub const VRInitError_Compositor_CreateClampToBorderSamplerState: Self = Self(442);
    pub const VRInitError_Compositor_CreateAnisoSamplerState: Self = Self(443);
    pub const VRInitError_Compositor_CreateOverlaySamplerState: Self = Self(444);
    pub const VRInitError_Compositor_CreatePanoramaSamplerState: Self = Self(445);
    pub const VRInitError_Compositor_CreateFontSamplerState: Self = Self(446);
    pub const VRInitError_Compositor_CreateNoBlendState: Self = Self(447);
    pub const VRInitError_Compositor_CreateBlendState: Self = Self(448);
    pub const VRInitError_Compositor_CreateAlphaBlendState: Self = Self(449);
    pub const VRInitError_Compositor_CreateBlendStateMaskR: Self = Self(450);
    pub const VRInitError_Compositor_CreateBlendStateMaskG: Self = Self(451);
    pub const VRInitError_Compositor_CreateBlendStateMaskB: Self = Self(452);
    pub const VRInitError_Compositor_CreateDepthStencilState: Self = Self(453);
    pub const VRInitError_Compositor_CreateDepthStencilStateNoWrite: Self = Self(454);
    pub const VRInitError_Compositor_CreateDepthStencilStateNoDepth: Self = Self(455);
    pub const VRInitError_Compositor_CreateFlushTexture: Self = Self(456);
    pub const VRInitError_Compositor_CreateDistortionSurfaces: Self = Self(457);
    pub const VRInitError_Compositor_CreateConstantBuffer: Self = Self(458);
    pub const VRInitError_Compositor_CreateHmdPoseConstantBuffer: Self = Self(459);
    pub const VRInitError_Compositor_CreateHmdPoseStagingConstantBuffer: Self = Self(460);
    pub const VRInitError_Compositor_CreateSharedFrameInfoConstantBuffer: Self = Self(461);
    pub const VRInitError_Compositor_CreateOverlayConstantBuffer: Self = Self(462);
    pub const VRInitError_Compositor_CreateSceneTextureIndexConstantBuffer: Self = Self(463);
    pub const VRInitError_Compositor_CreateReadableSceneTextureIndexConstantBuffer: Self = Self(464);
    pub const VRInitError_Compositor_CreateLayerGraphicsTextureIndexConstantBuffer: Self = Self(465);
    pub const VRInitError_Compositor_CreateLayerComputeTextureIndexConstantBuffer: Self = Self(466);
    pub const VRInitError_Compositor_CreateLayerComputeSceneTextureIndexConstantBuffer: Self = Self(467);
    pub const VRInitError_Compositor_CreateComputeHmdPoseConstantBuffer: Self = Self(468);
    pub const VRInitError_Compositor_CreateGeomConstantBuffer: Self = Self(469);
    pub const VRInitError_Compositor_CreatePanelMaskConstantBuffer: Self = Self(470);
    pub const VRInitError_Compositor_CreatePixelSimUBO: Self = Self(471);
    pub const VRInitError_Compositor_CreateMSAARenderTextures: Self = Self(472);
    pub const VRInitError_Compositor_CreateResolveRenderTextures: Self = Self(473);
    pub const VRInitError_Compositor_CreateComputeResolveRenderTextures: Self = Self(474);
    pub const VRInitError_Compositor_CreateDriverDirectModeResolveTextures: Self = Self(475);
    pub const VRInitError_Compositor_OpenDriverDirectModeResolveTextures: Self = Self(476);
    pub const VRInitError_Compositor_CreateFallbackSyncTexture: Self = Self(477);
    pub const VRInitError_Compositor_ShareFallbackSyncTexture: Self = Self(478);
    pub const VRInitError_Compositor_CreateOverlayIndexBuffer: Self = Self(479);
    pub const VRInitError_Compositor_CreateOverlayVertexBuffer: Self = Self(480);
    pub const VRInitError_Compositor_CreateTextVertexBuffer: Self = Self(481);
    pub const VRInitError_Compositor_CreateTextIndexBuffer: Self = Self(482);
    pub const VRInitError_Compositor_CreateMirrorTextures: Self = Self(483);
    pub const VRInitError_Compositor_CreateLastFrameRenderTexture: Self = Self(484);
    pub const VRInitError_Compositor_CreateMirrorOverlay: Self = Self(485);
    pub const VRInitError_Compositor_FailedToCreateVirtualDisplayBackbuffer: Self = Self(486);
    pub const VRInitError_Compositor_DisplayModeNotSupported: Self = Self(487);
    pub const VRInitError_Compositor_CreateOverlayInvalidCall: Self = Self(488);
    pub const VRInitError_Compositor_CreateOverlayAlreadyInitialized: Self = Self(489);
    pub const VRInitError_Compositor_FailedToCreateMailbox: Self = Self(490);
    pub const VRInitError_Compositor_WindowInterfaceIsNull: Self = Self(491);
    pub const VRInitError_Compositor_SystemLayerCreateInstance: Self = Self(492);
    pub const VRInitError_Compositor_SystemLayerCreateSession: Self = Self(493);
    pub const VRInitError_Compositor_CreateInverseDistortUVs: Self = Self(494);
    pub const VRInitError_Compositor_CreateBackbufferDepth: Self = Self(495);
    pub const VRInitError_Compositor_CannotDRMLeaseDisplay: Self = Self(496);
    pub const VRInitError_Compositor_CannotConnectToDisplayServer: Self = Self(497);
    pub const VRInitError_Compositor_GnomeNoDRMLeasing: Self = Self(498);
    pub const VRInitError_Compositor_FailedToInitializeEncoder: Self = Self(499);
    pub const VRInitError_Compositor_CreateBlurTexture: Self = Self(500);
    pub const VRInitError_VendorSpecific_UnableToConnectToOculusRuntime: Self = Self(1000);
    pub const VRInitError_VendorSpecific_WindowsNotInDevMode: Self = Self(1001);
    pub const VRInitError_VendorSpecific_OculusLinkNotEnabled: Self = Self(1002);
    pub const VRInitError_VendorSpecific_HmdFound_CantOpenDevice: Self = Self(1101);
    pub const VRInitError_VendorSpecific_HmdFound_UnableToRequestConfigStart: Self = Self(1102);
    pub const VRInitError_VendorSpecific_HmdFound_NoStoredConfig: Self = Self(1103);
    pub const VRInitError_VendorSpecific_HmdFound_ConfigTooBig: Self = Self(1104);
    pub const VRInitError_VendorSpecific_HmdFound_ConfigTooSmall: Self = Self(1105);
    pub const VRInitError_VendorSpecific_HmdFound_UnableToInitZLib: Self = Self(1106);
    pub const VRInitError_VendorSpecific_HmdFound_CantReadFirmwareVersion: Self = Self(1107);
    pub const VRInitError_VendorSpecific_HmdFound_UnableToSendUserDataStart: Self = Self(1108);
    pub const VRInitError_VendorSpecific_HmdFound_UnableToGetUserDataStart: Self = Self(1109);
    pub const VRInitError_VendorSpecific_HmdFound_UnableToGetUserDataNext: Self = Self(1110);
    pub const VRInitError_VendorSpecific_HmdFound_UserDataAddressRange: Self = Self(1111);
    pub const VRInitError_VendorSpecific_HmdFound_UserDataError: Self = Self(1112);
    pub const VRInitError_VendorSpecific_HmdFound_ConfigFailedSanityCheck: Self = Self(1113);
    pub const VRInitError_VendorSpecific_OculusRuntimeBadInstall: Self = Self(1114);
    pub const VRInitError_VendorSpecific_HmdFound_UnexpectedConfiguration_1: Self = Self(1115);
    pub const VRInitError_VendorSpecific_Oasis_UnlockRequired: Self = Self(1150);
    pub const VRInitError_VendorSpecific_VRLink_OutdatedDriverMESA: Self = Self(1200);
    pub const VRInitError_VendorSpecific_VRLink_OutdatedDriverNVIDIA: Self = Self(1201);
    pub const VRInitError_VendorSpecific_VRLink_NoVideoSupport: Self = Self(1202);
    pub const VRInitError_Steam_SteamInstallationNotFound: Self = Self(2000);
    pub const VRInitError_LastError: Self = Self(2001);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRInputError(pub i32);
impl EVRInputError {
    pub const VRInputError_None: Self = Self(0);
    pub const VRInputError_NameNotFound: Self = Self(1);
    pub const VRInputError_WrongType: Self = Self(2);
    pub const VRInputError_InvalidHandle: Self = Self(3);
    pub const VRInputError_InvalidParam: Self = Self(4);
    pub const VRInputError_NoSteam: Self = Self(5);
    pub const VRInputError_MaxCapacityReached: Self = Self(6);
    pub const VRInputError_IPCError: Self = Self(7);
    pub const VRInputError_NoActiveActionSet: Self = Self(8);
    pub const VRInputError_InvalidDevice: Self = Self(9);
    pub const VRInputError_InvalidSkeleton: Self = Self(10);
    pub const VRInputError_InvalidBoneCount: Self = Self(11);
    pub const VRInputError_InvalidCompressedData: Self = Self(12);
    pub const VRInputError_NoData: Self = Self(13);
    pub const VRInputError_BufferTooSmall: Self = Self(14);
    pub const VRInputError_MismatchedActionManifest: Self = Self(15);
    pub const VRInputError_MissingSkeletonData: Self = Self(16);
    pub const VRInputError_InvalidBoneIndex: Self = Self(17);
    pub const VRInputError_InvalidPriority: Self = Self(18);
    pub const VRInputError_PermissionDenied: Self = Self(19);
    pub const VRInputError_InvalidRenderModel: Self = Self(20);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRMouseButton(pub i32);
impl EVRMouseButton {
    pub const VRMouseButton_Left: Self = Self(1);
    pub const VRMouseButton_Right: Self = Self(2);
    pub const VRMouseButton_Middle: Self = Self(4);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVROverlayError(pub i32);
impl EVROverlayError {
    pub const VROverlayError_None: Self = Self(0);
    pub const VROverlayError_UnknownOverlay: Self = Self(10);
    pub const VROverlayError_InvalidHandle: Self = Self(11);
    pub const VROverlayError_PermissionDenied: Self = Self(12);
    pub const VROverlayError_OverlayLimitExceeded: Self = Self(13);
    pub const VROverlayError_WrongVisibilityType: Self = Self(14);
    pub const VROverlayError_KeyTooLong: Self = Self(15);
    pub const VROverlayError_NameTooLong: Self = Self(16);
    pub const VROverlayError_KeyInUse: Self = Self(17);
    pub const VROverlayError_WrongTransformType: Self = Self(18);
    pub const VROverlayError_InvalidTrackedDevice: Self = Self(19);
    pub const VROverlayError_InvalidParameter: Self = Self(20);
    pub const VROverlayError_ThumbnailCantBeDestroyed: Self = Self(21);
    pub const VROverlayError_ArrayTooSmall: Self = Self(22);
    pub const VROverlayError_RequestFailed: Self = Self(23);
    pub const VROverlayError_InvalidTexture: Self = Self(24);
    pub const VROverlayError_UnableToLoadFile: Self = Self(25);
    pub const VROverlayError_KeyboardAlreadyInUse: Self = Self(26);
    pub const VROverlayError_NoNeighbor: Self = Self(27);
    pub const VROverlayError_TooManyMaskPrimitives: Self = Self(29);
    pub const VROverlayError_BadMaskPrimitive: Self = Self(30);
    pub const VROverlayError_TextureAlreadyLocked: Self = Self(31);
    pub const VROverlayError_TextureLockCapacityReached: Self = Self(32);
    pub const VROverlayError_TextureNotLocked: Self = Self(33);
    pub const VROverlayError_TimedOut: Self = Self(34);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRSceneApplicationState(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRSkeletalMotionRange(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRSkeletalReferencePose(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRSkeletalTrackingLevel(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRSkeletalTransformSpace(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRState(pub i32);
impl EVRState {
    pub const VRState_Undefined: Self = Self(-1);
    pub const VRState_Off: Self = Self(0);
    pub const VRState_Searching: Self = Self(1);
    pub const VRState_Searching_Alert: Self = Self(2);
    pub const VRState_Ready: Self = Self(3);
    pub const VRState_Ready_Alert: Self = Self(4);
    pub const VRState_NotReady: Self = Self(5);
    pub const VRState_Standby: Self = Self(6);
    pub const VRState_Ready_Alert_Low: Self = Self(7);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRSubmitFlags(pub i32);
impl EVRSubmitFlags {
    pub const Submit_Default: Self = Self(0);
    pub const Submit_LensDistortionAlreadyApplied: Self = Self(1);
    pub const Submit_GlRenderBuffer: Self = Self(2);
    pub const Submit_Reserved: Self = Self(4);
    pub const Submit_TextureWithPose: Self = Self(8);
    pub const Submit_TextureWithDepth: Self = Self(16);
    pub const Submit_FrameDiscontinuity: Self = Self(32);
    pub const Submit_VulkanTextureWithArrayData: Self = Self(64);
    pub const Submit_GlArrayTexture: Self = Self(128);
    pub const Submit_IsEgl: Self = Self(256);
    pub const Submit_TextureWithMotion: Self = Self(536);
    pub const Submit_Reserved2: Self = Self(32768);
    pub const Submit_Reserved3: Self = Self(65536);
    pub const Submit_Reserved4: Self = Self(131072);
    pub const Submit_Reserved5: Self = Self(262144);
    pub const Submit_Reserved6: Self = Self(524288);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRSummaryType(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct VRMessageOverlayResponse(pub i32);

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct VROverlayFlags(pub i32);
impl VROverlayFlags {
    pub const NoDashboardTab: Self = Self(8);
    pub const SendVRDiscreteScrollEvents: Self = Self(64);
    pub const SendVRTouchpadEvents: Self = Self(128);
    pub const ShowTouchPadScrollWheel: Self = Self(256);
    pub const TransferOwnershipToInternalProcess: Self = Self(512);
    pub const SideBySide_Parallel: Self = Self(1024);
    pub const SideBySide_Crossed: Self = Self(2048);
    pub const Panorama: Self = Self(4096);
    pub const StereoPanorama: Self = Self(8192);
    pub const SortWithNonSceneOverlays: Self = Self(16384);
    pub const VisibleInDashboard: Self = Self(32768);
    pub const MakeOverlaysInteractiveIfVisible: Self = Self(65536);
    pub const SendVRSmoothScrollEvents: Self = Self(131072);
    pub const ProtectedContent: Self = Self(262144);
    pub const HideLaserIntersection: Self = Self(524288);
    pub const WantsModalBehavior: Self = Self(1048576);
    pub const IsPremultiplied: Self = Self(2097152);
    pub const IgnoreTextureAlpha: Self = Self(4194304);
    pub const EnableControlBar: Self = Self(8388608);
    pub const EnableControlBarKeyboard: Self = Self(16777216);
    pub const EnableControlBarClose: Self = Self(33554432);
    pub const MinimalControlBar: Self = Self(67108864);
    pub const EnableClickStabilization: Self = Self(134217728);
    pub const MultiCursor: Self = Self(268435456);
    pub const NoBackside: Self = Self(536870912);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct VROverlayInputMethod(pub i32);
impl VROverlayInputMethod {
    pub const None: Self = Self(0);
    pub const Mouse: Self = Self(1);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct VROverlayTransformType(pub i32);
impl VROverlayTransformType {
    pub const VROverlayTransform_Invalid: Self = Self(-1);
    pub const VROverlayTransform_Absolute: Self = Self(0);
    pub const VROverlayTransform_TrackedDeviceRelative: Self = Self(1);
    pub const VROverlayTransform_TrackedComponent: Self = Self(3);
    pub const VROverlayTransform_Cursor: Self = Self(4);
    pub const VROverlayTransform_DashboardTab: Self = Self(5);
    pub const VROverlayTransform_DashboardThumb: Self = Self(6);
    pub const VROverlayTransform_Mountable: Self = Self(7);
    pub const VROverlayTransform_Projection: Self = Self(8);
    pub const VROverlayTransform_Subview: Self = Self(9);
}

impl VREvent_t {
    pub fn event_type(&self) -> EVREventType { EVREventType(self.eventType as i32) }
}

#[repr(C)]
pub struct VR_IVRSystem_FnTable {
    pub GetRecommendedRenderTargetSize: Option<unsafe extern "system" fn(pnWidth: *mut u32, pnHeight: *mut u32)>,
    pub GetProjectionMatrix: Option<unsafe extern "system" fn(eEye: EVREye, fNearZ: f32, fFarZ: f32) -> HmdMatrix44_t>,
    pub GetProjectionRaw: Option<unsafe extern "system" fn(eEye: EVREye, pfLeft: *mut f32, pfRight: *mut f32, pfTop: *mut f32, pfBottom: *mut f32)>,
    pub ComputeDistortion: Option<unsafe extern "system" fn(eEye: EVREye, fU: f32, fV: f32, pDistortionCoordinates: *mut c_void) -> bool>,
    pub ComputeDistortionSet: Option<unsafe extern "system" fn(eEye: EVREye, eChannel: EVRDistortionChannel, bAsNormalizedDeviceCoordinates: bool, nNumCoordinates: u32, pInput: *const c_void, pOutput: *mut c_void) -> bool>,
    pub GetEyeToHeadTransform: Option<unsafe extern "system" fn(eEye: EVREye) -> HmdMatrix34_t>,
    pub GetTimeSinceLastVsync: Option<unsafe extern "system" fn(pfSecondsSinceLastVsync: *mut f32, pulFrameCounter: *mut u64) -> bool>,
    pub GetD3D9AdapterIndex: Option<unsafe extern "system" fn() -> i32>,
    pub GetDXGIOutputInfo: Option<unsafe extern "system" fn(pnAdapterIndex: *mut i32)>,
    pub GetOutputDevice: Option<unsafe extern "system" fn(pnDevice: *mut u64, textureType: ETextureType, pInstance: *mut c_void)>,
    pub IsDisplayOnDesktop: Option<unsafe extern "system" fn() -> bool>,
    pub SetDisplayVisibility: Option<unsafe extern "system" fn(bIsVisibleOnDesktop: bool) -> bool>,
    pub GetDeviceToAbsoluteTrackingPose: Option<unsafe extern "system" fn(eOrigin: ETrackingUniverseOrigin, fPredictedSecondsToPhotonsFromNow: f32, pTrackedDevicePoseArray: *mut TrackedDevicePose_t, unTrackedDevicePoseArrayCount: u32)>,
    pub GetSeatedZeroPoseToStandingAbsoluteTrackingPose: Option<unsafe extern "system" fn() -> HmdMatrix34_t>,
    pub GetRawZeroPoseToStandingAbsoluteTrackingPose: Option<unsafe extern "system" fn() -> HmdMatrix34_t>,
    pub GetSortedTrackedDeviceIndicesOfClass: Option<unsafe extern "system" fn(eTrackedDeviceClass: ETrackedDeviceClass, punTrackedDeviceIndexArray: *mut TrackedDeviceIndex_t, unTrackedDeviceIndexArrayCount: u32, unRelativeToTrackedDeviceIndex: TrackedDeviceIndex_t) -> u32>,
    pub GetTrackedDeviceActivityLevel: Option<unsafe extern "system" fn(unDeviceId: TrackedDeviceIndex_t) -> EDeviceActivityLevel>,
    pub ApplyTransform: Option<unsafe extern "system" fn(pOutputPose: *mut TrackedDevicePose_t, pTrackedDevicePose: *const TrackedDevicePose_t, pTransform: *const HmdMatrix34_t)>,
    pub GetTrackedDeviceIndexForControllerRole: Option<unsafe extern "system" fn(unDeviceType: ETrackedControllerRole) -> TrackedDeviceIndex_t>,
    pub GetControllerRoleForTrackedDeviceIndex: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t) -> ETrackedControllerRole>,
    pub GetTrackedDeviceClass: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t) -> ETrackedDeviceClass>,
    pub IsTrackedDeviceConnected: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t) -> bool>,
    pub GetBoolTrackedDeviceProperty: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t, prop: ETrackedDeviceProperty, pError: *mut ETrackedPropertyError) -> bool>,
    pub GetFloatTrackedDeviceProperty: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t, prop: ETrackedDeviceProperty, pError: *mut ETrackedPropertyError) -> f32>,
    pub GetInt32TrackedDeviceProperty: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t, prop: ETrackedDeviceProperty, pError: *mut ETrackedPropertyError) -> i32>,
    pub GetUint64TrackedDeviceProperty: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t, prop: ETrackedDeviceProperty, pError: *mut ETrackedPropertyError) -> u64>,
    pub GetMatrix34TrackedDeviceProperty: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t, prop: ETrackedDeviceProperty, pError: *mut ETrackedPropertyError) -> HmdMatrix34_t>,
    pub GetArrayTrackedDeviceProperty: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t, prop: ETrackedDeviceProperty, propType: PropertyTypeTag_t, pBuffer: *mut c_void, unBufferSize: u32, pError: *mut ETrackedPropertyError) -> u32>,
    pub GetStringTrackedDeviceProperty: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t, prop: ETrackedDeviceProperty, pchValue: *mut c_char, unBufferSize: u32, pError: *mut ETrackedPropertyError) -> u32>,
    pub GetPropErrorNameFromEnum: Option<unsafe extern "system" fn(error: ETrackedPropertyError) -> *mut c_char>,
    pub PollNextEvent: Option<unsafe extern "system" fn(pEvent: *mut VREvent_t, uncbVREvent: u32) -> bool>,
    pub PollNextEventWithPose: Option<unsafe extern "system" fn(eOrigin: ETrackingUniverseOrigin, pEvent: *mut VREvent_t, uncbVREvent: u32, pTrackedDevicePose: *mut TrackedDevicePose_t) -> bool>,
    pub PollNextEventWithPoseAndOverlays: Option<unsafe extern "system" fn(eOrigin: ETrackingUniverseOrigin, pEvent: *mut VREvent_t, uncbVREvent: u32, pTrackedDevicePose: *mut TrackedDevicePose_t, pulOverlayHandle: *mut VROverlayHandle_t) -> bool>,
    pub GetEventTypeNameFromEnum: Option<unsafe extern "system" fn(eType: EVREventType) -> *mut c_char>,
    pub GetHiddenAreaMesh: Option<unsafe extern "system" fn(eEye: EVREye, r#type: EHiddenAreaMeshType) -> HiddenAreaMesh_t>,
    pub GetEyeTrackedFoveationCenter: Option<unsafe extern "system" fn(pNdcLeft: *mut HmdVector2_t, pNdcRight: *mut HmdVector2_t) -> bool>,
    pub GetEyeTrackedFoveationCenterForProjection: Option<unsafe extern "system" fn(pProjMat: *const HmdMatrix44_t, pNdc: *mut HmdVector2_t) -> bool>,
    pub GetControllerState: Option<unsafe extern "system" fn(unControllerDeviceIndex: TrackedDeviceIndex_t, pControllerState: *mut c_void, unControllerStateSize: u32) -> bool>,
    pub GetControllerStateWithPose: Option<unsafe extern "system" fn(eOrigin: ETrackingUniverseOrigin, unControllerDeviceIndex: TrackedDeviceIndex_t, pControllerState: *mut c_void, unControllerStateSize: u32, pTrackedDevicePose: *mut TrackedDevicePose_t) -> bool>,
    pub TriggerHapticPulse: Option<unsafe extern "system" fn(unControllerDeviceIndex: TrackedDeviceIndex_t, unAxisId: u32, usDurationMicroSec: u16)>,
    pub GetButtonIdNameFromEnum: Option<unsafe extern "system" fn(eButtonId: EVRButtonId) -> *mut c_char>,
    pub GetControllerAxisTypeNameFromEnum: Option<unsafe extern "system" fn(eAxisType: EVRControllerAxisType) -> *mut c_char>,
    pub IsInputAvailable: Option<unsafe extern "system" fn() -> bool>,
    pub IsSteamVRDrawingControllers: Option<unsafe extern "system" fn() -> bool>,
    pub ShouldApplicationPause: Option<unsafe extern "system" fn() -> bool>,
    pub ShouldApplicationReduceRenderingWork: Option<unsafe extern "system" fn() -> bool>,
    pub PerformFirmwareUpdate: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t) -> EVRFirmwareError>,
    pub AcknowledgeQuit_Exiting: Option<unsafe extern "system" fn()>,
    pub GetAppContainerFilePaths: Option<unsafe extern "system" fn(pchBuffer: *mut c_char, unBufferSize: u32) -> u32>,
    pub GetRuntimeVersion: Option<unsafe extern "system" fn() -> *mut c_char>,
    pub SetSDKVersion: Option<unsafe extern "system" fn(nVersionMajor: u32, nVersionMinor: u32, nVersionBuild: u32) -> EVRInitError>,
}
const _: () = assert!(std::mem::size_of::<VR_IVRSystem_FnTable>() == 51 * 8);

#[repr(C)]
pub struct VR_IVRCompositor_FnTable {
    pub SetTrackingSpace: Option<unsafe extern "system" fn(eOrigin: ETrackingUniverseOrigin)>,
    pub GetTrackingSpace: Option<unsafe extern "system" fn() -> ETrackingUniverseOrigin>,
    pub WaitGetPoses: Option<unsafe extern "system" fn(pRenderPoseArray: *mut TrackedDevicePose_t, unRenderPoseArrayCount: u32, pGamePoseArray: *mut TrackedDevicePose_t, unGamePoseArrayCount: u32) -> EVRCompositorError>,
    pub GetLastPoses: Option<unsafe extern "system" fn(pRenderPoseArray: *mut TrackedDevicePose_t, unRenderPoseArrayCount: u32, pGamePoseArray: *mut TrackedDevicePose_t, unGamePoseArrayCount: u32) -> EVRCompositorError>,
    pub GetLastPoseForTrackedDeviceIndex: Option<unsafe extern "system" fn(unDeviceIndex: TrackedDeviceIndex_t, pOutputPose: *mut TrackedDevicePose_t, pOutputGamePose: *mut TrackedDevicePose_t) -> EVRCompositorError>,
    pub GetSubmitTexture: Option<unsafe extern "system" fn(pOutTexture: *mut Texture_t, pNeedsFlush: *mut bool, eUsage: EVRCompositorTextureUsage, pTexture: *const Texture_t, pBounds: *const VRTextureBounds_t, nSubmitFlags: EVRSubmitFlags) -> EVRCompositorError>,
    pub Submit: Option<unsafe extern "system" fn(eEye: EVREye, pTexture: *const Texture_t, pBounds: *const VRTextureBounds_t, nSubmitFlags: EVRSubmitFlags) -> EVRCompositorError>,
    pub SubmitWithArrayIndex: Option<unsafe extern "system" fn(eEye: EVREye, pTexture: *const Texture_t, unTextureArrayIndex: u32, pBounds: *const VRTextureBounds_t, nSubmitFlags: EVRSubmitFlags) -> EVRCompositorError>,
    pub ClearLastSubmittedFrame: Option<unsafe extern "system" fn()>,
    pub PostPresentHandoff: Option<unsafe extern "system" fn()>,
    pub GetFrameTiming: Option<unsafe extern "system" fn(pTiming: *mut c_void, unFramesAgo: u32) -> bool>,
    pub GetFrameTimings: Option<unsafe extern "system" fn(pTiming: *mut c_void, nFrames: u32) -> u32>,
    pub GetFrameTimeRemaining: Option<unsafe extern "system" fn() -> f32>,
    pub GetCumulativeStats: Option<unsafe extern "system" fn(pStats: *mut c_void, nStatsSizeInBytes: u32)>,
    pub FadeToColor: Option<unsafe extern "system" fn(fSeconds: f32, fRed: f32, fGreen: f32, fBlue: f32, fAlpha: f32, bBackground: bool)>,
    pub GetCurrentFadeColor: Option<unsafe extern "system" fn(bBackground: bool) -> HmdColor_t>,
    pub FadeGrid: Option<unsafe extern "system" fn(fSeconds: f32, bFadeGridIn: bool)>,
    pub GetCurrentGridAlpha: Option<unsafe extern "system" fn() -> f32>,
    pub SetSkyboxOverride: Option<unsafe extern "system" fn(pTextures: *const Texture_t, unTextureCount: u32) -> EVRCompositorError>,
    pub ClearSkyboxOverride: Option<unsafe extern "system" fn()>,
    pub CompositorBringToFront: Option<unsafe extern "system" fn()>,
    pub CompositorGoToBack: Option<unsafe extern "system" fn()>,
    pub CompositorQuit: Option<unsafe extern "system" fn()>,
    pub IsFullscreen: Option<unsafe extern "system" fn() -> bool>,
    pub GetCurrentSceneFocusProcess: Option<unsafe extern "system" fn() -> u32>,
    pub GetLastFrameRenderer: Option<unsafe extern "system" fn() -> u32>,
    pub CanRenderScene: Option<unsafe extern "system" fn() -> bool>,
    pub ShowMirrorWindow: Option<unsafe extern "system" fn()>,
    pub HideMirrorWindow: Option<unsafe extern "system" fn()>,
    pub IsMirrorWindowVisible: Option<unsafe extern "system" fn() -> bool>,
    pub CompositorDumpImages: Option<unsafe extern "system" fn()>,
    pub ShouldAppRenderWithLowResources: Option<unsafe extern "system" fn() -> bool>,
    pub ForceInterleavedReprojectionOn: Option<unsafe extern "system" fn(bOverride: bool)>,
    pub ForceReconnectProcess: Option<unsafe extern "system" fn()>,
    pub SuspendRendering: Option<unsafe extern "system" fn(bSuspend: bool)>,
    pub GetMirrorTextureD3D11: Option<unsafe extern "system" fn(eEye: EVREye, pD3D11DeviceOrResource: *mut c_void, ppD3D11ShaderResourceView: *mut *mut c_void) -> EVRCompositorError>,
    pub ReleaseMirrorTextureD3D11: Option<unsafe extern "system" fn(pD3D11ShaderResourceView: *mut c_void)>,
    pub GetMirrorTextureGL: Option<unsafe extern "system" fn(eEye: EVREye, pglTextureId: *mut glUInt_t, pglSharedTextureHandle: *mut *mut c_void) -> EVRCompositorError>,
    pub ReleaseSharedGLTexture: Option<unsafe extern "system" fn(glTextureId: glUInt_t, glSharedTextureHandle: *mut c_void) -> bool>,
    pub LockGLSharedTextureForAccess: Option<unsafe extern "system" fn(glSharedTextureHandle: *mut c_void)>,
    pub UnlockGLSharedTextureForAccess: Option<unsafe extern "system" fn(glSharedTextureHandle: *mut c_void)>,
    pub GetVulkanInstanceExtensionsRequired: Option<unsafe extern "system" fn(pchValue: *mut c_char, unBufferSize: u32) -> u32>,
    pub GetVulkanDeviceExtensionsRequired: Option<unsafe extern "system" fn(pPhysicalDevice: *mut c_void, pchValue: *mut c_char, unBufferSize: u32) -> u32>,
    pub SetExplicitTimingMode: Option<unsafe extern "system" fn(eTimingMode: EVRCompositorTimingMode)>,
    pub SubmitExplicitTimingData: Option<unsafe extern "system" fn() -> EVRCompositorError>,
    pub IsMotionSmoothingEnabled: Option<unsafe extern "system" fn() -> bool>,
    pub IsMotionSmoothingSupported: Option<unsafe extern "system" fn() -> bool>,
    pub IsCurrentSceneFocusAppLoading: Option<unsafe extern "system" fn() -> bool>,
    pub SetStageOverride_Async: Option<unsafe extern "system" fn(pchRenderModelPath: *const c_char, pTransform: *const HmdMatrix34_t, pRenderSettings: *const c_void, nSizeOfRenderSettings: u32) -> EVRCompositorError>,
    pub ClearStageOverride: Option<unsafe extern "system" fn()>,
    pub GetCompositorBenchmarkResults: Option<unsafe extern "system" fn(pBenchmarkResults: *mut c_void, nSizeOfBenchmarkResults: u32) -> bool>,
    pub GetLastPosePredictionIDs: Option<unsafe extern "system" fn(pRenderPosePredictionID: *mut u32, pGamePosePredictionID: *mut u32) -> EVRCompositorError>,
    pub GetPosesForFrame: Option<unsafe extern "system" fn(unPosePredictionID: u32, pPoseArray: *mut TrackedDevicePose_t, unPoseArrayCount: u32) -> EVRCompositorError>,
}
const _: () = assert!(std::mem::size_of::<VR_IVRCompositor_FnTable>() == 53 * 8);

#[repr(C)]
pub struct VR_IVROverlay_FnTable {
    pub FindOverlay: Option<unsafe extern "system" fn(pchOverlayKey: *const c_char, pOverlayHandle: *mut VROverlayHandle_t) -> EVROverlayError>,
    pub CreateOverlay: Option<unsafe extern "system" fn(pchOverlayKey: *const c_char, pchOverlayName: *const c_char, pOverlayHandle: *mut VROverlayHandle_t) -> EVROverlayError>,
    pub CreateSubviewOverlay: Option<unsafe extern "system" fn(parentOverlayHandle: VROverlayHandle_t, pchSubviewOverlayKey: *const c_char, pchSubviewOverlayName: *const c_char, pSubviewOverlayHandle: *mut VROverlayHandle_t) -> EVROverlayError>,
    pub DestroyOverlay: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> EVROverlayError>,
    pub GetOverlayKey: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pchValue: *mut c_char, unBufferSize: u32, pError: *mut EVROverlayError) -> u32>,
    pub GetOverlayName: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pchValue: *mut c_char, unBufferSize: u32, pError: *mut EVROverlayError) -> u32>,
    pub SetOverlayName: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pchName: *const c_char) -> EVROverlayError>,
    pub GetOverlayImageData: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pvBuffer: *mut c_void, unBufferSize: u32, punWidth: *mut u32, punHeight: *mut u32) -> EVROverlayError>,
    pub GetOverlayErrorNameFromEnum: Option<unsafe extern "system" fn(error: EVROverlayError) -> *mut c_char>,
    pub SetOverlayRenderingPid: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, unPID: u32) -> EVROverlayError>,
    pub GetOverlayRenderingPid: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> u32>,
    pub SetOverlayFlag: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, eOverlayFlag: VROverlayFlags, bEnabled: bool) -> EVROverlayError>,
    pub GetOverlayFlag: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, eOverlayFlag: VROverlayFlags, pbEnabled: *mut bool) -> EVROverlayError>,
    pub GetOverlayFlags: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pFlags: *mut u32) -> EVROverlayError>,
    pub SetOverlayColor: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, fRed: f32, fGreen: f32, fBlue: f32) -> EVROverlayError>,
    pub GetOverlayColor: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pfRed: *mut f32, pfGreen: *mut f32, pfBlue: *mut f32) -> EVROverlayError>,
    pub SetOverlayAlpha: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, fAlpha: f32) -> EVROverlayError>,
    pub GetOverlayAlpha: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pfAlpha: *mut f32) -> EVROverlayError>,
    pub SetOverlayTexelAspect: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, fTexelAspect: f32) -> EVROverlayError>,
    pub GetOverlayTexelAspect: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pfTexelAspect: *mut f32) -> EVROverlayError>,
    pub SetOverlaySortOrder: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, unSortOrder: u32) -> EVROverlayError>,
    pub GetOverlaySortOrder: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, punSortOrder: *mut u32) -> EVROverlayError>,
    pub SetOverlayWidthInMeters: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, fWidthInMeters: f32) -> EVROverlayError>,
    pub GetOverlayWidthInMeters: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pfWidthInMeters: *mut f32) -> EVROverlayError>,
    pub SetOverlayCurvature: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, fCurvature: f32) -> EVROverlayError>,
    pub GetOverlayCurvature: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pfCurvature: *mut f32) -> EVROverlayError>,
    pub SetOverlayPreCurvePitch: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, fRadians: f32) -> EVROverlayError>,
    pub GetOverlayPreCurvePitch: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pfRadians: *mut f32) -> EVROverlayError>,
    pub SetOverlayTextureColorSpace: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, eTextureColorSpace: EColorSpace) -> EVROverlayError>,
    pub GetOverlayTextureColorSpace: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, peTextureColorSpace: *mut EColorSpace) -> EVROverlayError>,
    pub SetOverlayTextureBounds: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pOverlayTextureBounds: *const VRTextureBounds_t) -> EVROverlayError>,
    pub GetOverlayTextureBounds: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pOverlayTextureBounds: *mut VRTextureBounds_t) -> EVROverlayError>,
    pub GetOverlayTransformType: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, peTransformType: *mut VROverlayTransformType) -> EVROverlayError>,
    pub SetOverlayTransformAbsolute: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, eTrackingOrigin: ETrackingUniverseOrigin, pmatTrackingOriginToOverlayTransform: *const HmdMatrix34_t) -> EVROverlayError>,
    pub GetOverlayTransformAbsolute: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, peTrackingOrigin: *mut ETrackingUniverseOrigin, pmatTrackingOriginToOverlayTransform: *mut HmdMatrix34_t) -> EVROverlayError>,
    pub SetOverlayTransformTrackedDeviceRelative: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, unTrackedDevice: TrackedDeviceIndex_t, pmatTrackedDeviceToOverlayTransform: *const HmdMatrix34_t) -> EVROverlayError>,
    pub GetOverlayTransformTrackedDeviceRelative: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, punTrackedDevice: *mut TrackedDeviceIndex_t, pmatTrackedDeviceToOverlayTransform: *mut HmdMatrix34_t) -> EVROverlayError>,
    pub SetOverlayTransformTrackedDeviceComponent: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, unDeviceIndex: TrackedDeviceIndex_t, pchComponentName: *const c_char) -> EVROverlayError>,
    pub GetOverlayTransformTrackedDeviceComponent: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, punDeviceIndex: *mut TrackedDeviceIndex_t, pchComponentName: *mut c_char, unComponentNameSize: u32) -> EVROverlayError>,
    pub SetOverlayTransformCursor: Option<unsafe extern "system" fn(ulCursorOverlayHandle: VROverlayHandle_t, pvHotspot: *const HmdVector2_t) -> EVROverlayError>,
    pub GetOverlayTransformCursor: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pvHotspot: *mut HmdVector2_t) -> EVROverlayError>,
    pub SetOverlayTransformProjection: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, eTrackingOrigin: ETrackingUniverseOrigin, pmatTrackingOriginToOverlayTransform: *const HmdMatrix34_t, pProjection: *const c_void, eEye: EVREye) -> EVROverlayError>,
    pub SetSubviewPosition: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, fX: f32, fY: f32) -> EVROverlayError>,
    pub ShowOverlay: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> EVROverlayError>,
    pub HideOverlay: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> EVROverlayError>,
    pub IsOverlayVisible: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> bool>,
    pub GetTransformForOverlayCoordinates: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, eTrackingOrigin: ETrackingUniverseOrigin, coordinatesInOverlay: HmdVector2_t, pmatTransform: *mut HmdMatrix34_t) -> EVROverlayError>,
    pub WaitFrameSync: Option<unsafe extern "system" fn(nTimeoutMs: u32) -> EVROverlayError>,
    pub PollNextOverlayEvent: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pEvent: *mut VREvent_t, uncbVREvent: u32) -> bool>,
    pub GetOverlayInputMethod: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, peInputMethod: *mut VROverlayInputMethod) -> EVROverlayError>,
    pub SetOverlayInputMethod: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, eInputMethod: VROverlayInputMethod) -> EVROverlayError>,
    pub GetOverlayMouseScale: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pvecMouseScale: *mut HmdVector2_t) -> EVROverlayError>,
    pub SetOverlayMouseScale: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pvecMouseScale: *const HmdVector2_t) -> EVROverlayError>,
    pub ComputeOverlayIntersection: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pParams: *const c_void, pResults: *mut c_void) -> bool>,
    pub IsHoverTargetOverlay: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> bool>,
    pub SetOverlayIntersectionMask: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pMaskPrimitives: *mut c_void, unNumMaskPrimitives: u32, unPrimitiveSize: u32) -> EVROverlayError>,
    pub TriggerLaserMouseHapticVibration: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, fDurationSeconds: f32, fFrequency: f32, fAmplitude: f32) -> EVROverlayError>,
    pub SetOverlayCursor: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, ulCursorHandle: VROverlayHandle_t) -> EVROverlayError>,
    pub SetOverlayCursorPositionOverride: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pvCursor: *const HmdVector2_t) -> EVROverlayError>,
    pub ClearOverlayCursorPositionOverride: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> EVROverlayError>,
    pub SetOverlayTexture: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pTexture: *const Texture_t) -> EVROverlayError>,
    pub ClearOverlayTexture: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> EVROverlayError>,
    pub SetOverlayRaw: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pvBuffer: *mut c_void, unWidth: u32, unHeight: u32, unBytesPerPixel: u32) -> EVROverlayError>,
    pub SetOverlayFromFile: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pchFilePath: *const c_char) -> EVROverlayError>,
    pub GetOverlayTexture: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pNativeTextureHandle: *mut *mut c_void, pNativeTextureRef: *mut c_void, pWidth: *mut u32, pHeight: *mut u32, pNativeFormat: *mut u32, pAPIType: *mut ETextureType, pColorSpace: *mut EColorSpace, pTextureBounds: *mut VRTextureBounds_t) -> EVROverlayError>,
    pub ReleaseNativeOverlayHandle: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pNativeTextureHandle: *mut c_void) -> EVROverlayError>,
    pub GetOverlayTextureSize: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, pWidth: *mut u32, pHeight: *mut u32) -> EVROverlayError>,
    pub CreateDashboardOverlay: Option<unsafe extern "system" fn(pchOverlayKey: *const c_char, pchOverlayFriendlyName: *const c_char, pMainHandle: *mut VROverlayHandle_t, pThumbnailHandle: *mut VROverlayHandle_t) -> EVROverlayError>,
    pub IsDashboardVisible: Option<unsafe extern "system" fn() -> bool>,
    pub IsActiveDashboardOverlay: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t) -> bool>,
    pub SetDashboardOverlaySceneProcess: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, unProcessId: u32) -> EVROverlayError>,
    pub GetDashboardOverlaySceneProcess: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, punProcessId: *mut u32) -> EVROverlayError>,
    pub ShowDashboard: Option<unsafe extern "system" fn(pchOverlayToShow: *const c_char)>,
    pub GetPrimaryDashboardDevice: Option<unsafe extern "system" fn() -> TrackedDeviceIndex_t>,
    pub ShowKeyboard: Option<unsafe extern "system" fn(eInputMode: EGamepadTextInputMode, eLineInputMode: EGamepadTextInputLineMode, unFlags: u32, pchDescription: *const c_char, unCharMax: u32, pchExistingText: *const c_char, uUserValue: u64) -> EVROverlayError>,
    pub ShowKeyboardForOverlay: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, eInputMode: EGamepadTextInputMode, eLineInputMode: EGamepadTextInputLineMode, unFlags: u32, pchDescription: *const c_char, unCharMax: u32, pchExistingText: *const c_char, uUserValue: u64) -> EVROverlayError>,
    pub GetKeyboardText: Option<unsafe extern "system" fn(pchText: *mut c_char, cchText: u32) -> u32>,
    pub HideKeyboard: Option<unsafe extern "system" fn()>,
    pub SetKeyboardTransformAbsolute: Option<unsafe extern "system" fn(eTrackingOrigin: ETrackingUniverseOrigin, pmatTrackingOriginToKeyboardTransform: *const HmdMatrix34_t)>,
    pub SetKeyboardPositionForOverlay: Option<unsafe extern "system" fn(ulOverlayHandle: VROverlayHandle_t, avoidRect: HmdRect2_t)>,
    pub ShowMessageOverlay: Option<unsafe extern "system" fn(pchText: *const c_char, pchCaption: *const c_char, pchButton0Text: *const c_char, pchButton1Text: *const c_char, pchButton2Text: *const c_char, pchButton3Text: *const c_char) -> VRMessageOverlayResponse>,
    pub CloseMessageOverlay: Option<unsafe extern "system" fn()>,
}
const _: () = assert!(std::mem::size_of::<VR_IVROverlay_FnTable>() == 82 * 8);

#[repr(C)]
pub struct VR_IVRChaperone_FnTable {
    pub GetCalibrationState: Option<unsafe extern "system" fn() -> ChaperoneCalibrationState>,
    pub GetPlayAreaSize: Option<unsafe extern "system" fn(pSizeX: *mut f32, pSizeZ: *mut f32) -> bool>,
    pub GetPlayAreaRect: Option<unsafe extern "system" fn(rect: *mut HmdQuad_t) -> bool>,
    pub ReloadInfo: Option<unsafe extern "system" fn()>,
    pub SetSceneColor: Option<unsafe extern "system" fn(color: HmdColor_t)>,
    pub GetBoundsColor: Option<unsafe extern "system" fn(pOutputColorArray: *mut HmdColor_t, nNumOutputColors: i32, flCollisionBoundsFadeDistance: f32, pOutputCameraColor: *mut HmdColor_t)>,
    pub AreBoundsVisible: Option<unsafe extern "system" fn() -> bool>,
    pub ForceBoundsVisible: Option<unsafe extern "system" fn(bForce: bool)>,
    pub ResetZeroPose: Option<unsafe extern "system" fn(eTrackingUniverseOrigin: ETrackingUniverseOrigin)>,
}
const _: () = assert!(std::mem::size_of::<VR_IVRChaperone_FnTable>() == 9 * 8);

#[repr(C)]
pub struct VR_IVRInput_FnTable {
    pub SetActionManifestPath: Option<unsafe extern "system" fn(pchActionManifestPath: *const c_char) -> EVRInputError>,
    pub GetActionSetHandle: Option<unsafe extern "system" fn(pchActionSetName: *const c_char, pHandle: *mut VRActionSetHandle_t) -> EVRInputError>,
    pub GetActionHandle: Option<unsafe extern "system" fn(pchActionName: *const c_char, pHandle: *mut VRActionHandle_t) -> EVRInputError>,
    pub GetInputSourceHandle: Option<unsafe extern "system" fn(pchInputSourcePath: *const c_char, pHandle: *mut VRInputValueHandle_t) -> EVRInputError>,
    pub UpdateActionState: Option<unsafe extern "system" fn(pSets: *mut VRActiveActionSet_t, unSizeOfVRSelectedActionSet_t: u32, unSetCount: u32) -> EVRInputError>,
    pub GetDigitalActionData: Option<unsafe extern "system" fn(action: VRActionHandle_t, pActionData: *mut InputDigitalActionData_t, unActionDataSize: u32, ulRestrictToDevice: VRInputValueHandle_t) -> EVRInputError>,
    pub GetAnalogActionData: Option<unsafe extern "system" fn(action: VRActionHandle_t, pActionData: *mut InputAnalogActionData_t, unActionDataSize: u32, ulRestrictToDevice: VRInputValueHandle_t) -> EVRInputError>,
    pub GetPoseActionDataRelativeToNow: Option<unsafe extern "system" fn(action: VRActionHandle_t, eOrigin: ETrackingUniverseOrigin, fPredictedSecondsFromNow: f32, pActionData: *mut InputPoseActionData_t, unActionDataSize: u32, ulRestrictToDevice: VRInputValueHandle_t) -> EVRInputError>,
    pub GetPoseActionDataForNextFrame: Option<unsafe extern "system" fn(action: VRActionHandle_t, eOrigin: ETrackingUniverseOrigin, pActionData: *mut InputPoseActionData_t, unActionDataSize: u32, ulRestrictToDevice: VRInputValueHandle_t) -> EVRInputError>,
    pub GetSkeletalActionData: Option<unsafe extern "system" fn(action: VRActionHandle_t, pActionData: *mut c_void, unActionDataSize: u32) -> EVRInputError>,
    pub GetDominantHand: Option<unsafe extern "system" fn(peDominantHand: *mut ETrackedControllerRole) -> EVRInputError>,
    pub SetDominantHand: Option<unsafe extern "system" fn(eDominantHand: ETrackedControllerRole) -> EVRInputError>,
    pub GetEyeTrackingDataRelativeToNow: Option<unsafe extern "system" fn(action: VRActionHandle_t, eOrigin: ETrackingUniverseOrigin, fPredictedSecondsFromNow: f32, pEyeTrackingData: *mut c_void, ulEyeTrackingDataSize: u32) -> EVRInputError>,
    pub GetEyeTrackingDataForNextFrame: Option<unsafe extern "system" fn(action: VRActionHandle_t, eOrigin: ETrackingUniverseOrigin, pEyeTrackingData: *mut c_void, ulEyeTrackingDataSize: u32) -> EVRInputError>,
    pub GetBoneCount: Option<unsafe extern "system" fn(action: VRActionHandle_t, pBoneCount: *mut u32) -> EVRInputError>,
    pub GetBoneHierarchy: Option<unsafe extern "system" fn(action: VRActionHandle_t, pParentIndices: *mut i32, unIndexArayCount: u32) -> EVRInputError>,
    pub GetBoneName: Option<unsafe extern "system" fn(action: VRActionHandle_t, nBoneIndex: i32, pchBoneName: *mut c_char, unNameBufferSize: u32) -> EVRInputError>,
    pub GetSkeletalReferenceTransforms: Option<unsafe extern "system" fn(action: VRActionHandle_t, eTransformSpace: EVRSkeletalTransformSpace, eReferencePose: EVRSkeletalReferencePose, pTransformArray: *mut c_void, unTransformArrayCount: u32) -> EVRInputError>,
    pub GetSkeletalTrackingLevel: Option<unsafe extern "system" fn(action: VRActionHandle_t, pSkeletalTrackingLevel: *mut EVRSkeletalTrackingLevel) -> EVRInputError>,
    pub GetSkeletalBoneData: Option<unsafe extern "system" fn(action: VRActionHandle_t, eTransformSpace: EVRSkeletalTransformSpace, eMotionRange: EVRSkeletalMotionRange, pTransformArray: *mut c_void, unTransformArrayCount: u32) -> EVRInputError>,
    pub GetSkeletalSummaryData: Option<unsafe extern "system" fn(action: VRActionHandle_t, eSummaryType: EVRSummaryType, pSkeletalSummaryData: *mut c_void) -> EVRInputError>,
    pub GetSkeletalBoneDataCompressed: Option<unsafe extern "system" fn(action: VRActionHandle_t, eMotionRange: EVRSkeletalMotionRange, pvCompressedData: *mut c_void, unCompressedSize: u32, punRequiredCompressedSize: *mut u32) -> EVRInputError>,
    pub DecompressSkeletalBoneData: Option<unsafe extern "system" fn(pvCompressedBuffer: *const c_void, unCompressedBufferSize: u32, eTransformSpace: EVRSkeletalTransformSpace, pTransformArray: *mut c_void, unTransformArrayCount: u32) -> EVRInputError>,
    pub TriggerHapticVibrationAction: Option<unsafe extern "system" fn(action: VRActionHandle_t, fStartSecondsFromNow: f32, fDurationSeconds: f32, fFrequency: f32, fAmplitude: f32, ulRestrictToDevice: VRInputValueHandle_t) -> EVRInputError>,
    pub GetActionOrigins: Option<unsafe extern "system" fn(actionSetHandle: VRActionSetHandle_t, digitalActionHandle: VRActionHandle_t, originsOut: *mut VRInputValueHandle_t, originOutCount: u32) -> EVRInputError>,
    pub GetOriginLocalizedName: Option<unsafe extern "system" fn(origin: VRInputValueHandle_t, pchNameArray: *mut c_char, unNameArraySize: u32, unStringSectionsToInclude: i32) -> EVRInputError>,
    pub GetOriginTrackedDeviceInfo: Option<unsafe extern "system" fn(origin: VRInputValueHandle_t, pOriginInfo: *mut InputOriginInfo_t, unOriginInfoSize: u32) -> EVRInputError>,
    pub GetActionBindingInfo: Option<unsafe extern "system" fn(action: VRActionHandle_t, pOriginInfo: *mut c_void, unBindingInfoSize: u32, unBindingInfoCount: u32, punReturnedBindingInfoCount: *mut u32) -> EVRInputError>,
    pub ShowActionOrigins: Option<unsafe extern "system" fn(actionSetHandle: VRActionSetHandle_t, ulActionHandle: VRActionHandle_t) -> EVRInputError>,
    pub ShowBindingsForActionSet: Option<unsafe extern "system" fn(pSets: *mut VRActiveActionSet_t, unSizeOfVRSelectedActionSet_t: u32, unSetCount: u32, originToHighlight: VRInputValueHandle_t) -> EVRInputError>,
    pub GetComponentStateForBinding: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, pchComponentName: *const c_char, pOriginInfo: *const c_void, unBindingInfoSize: u32, unBindingInfoCount: u32, pComponentState: *mut c_void) -> EVRInputError>,
    pub IsUsingLegacyInput: Option<unsafe extern "system" fn() -> bool>,
    pub OpenBindingUI: Option<unsafe extern "system" fn(pchAppKey: *const c_char, ulActionSetHandle: VRActionSetHandle_t, ulDeviceHandle: VRInputValueHandle_t, bShowOnDesktop: bool) -> EVRInputError>,
    pub GetBindingVariant: Option<unsafe extern "system" fn(ulDevicePath: VRInputValueHandle_t, pchVariantArray: *mut c_char, unVariantArraySize: u32) -> EVRInputError>,
}
const _: () = assert!(std::mem::size_of::<VR_IVRInput_FnTable>() == 34 * 8);

#[repr(C)]
pub struct VR_IVRApplications_FnTable {
    pub AddApplicationManifest: Option<unsafe extern "system" fn(pchApplicationManifestFullPath: *const c_char, bTemporary: bool) -> EVRApplicationError>,
    pub RemoveApplicationManifest: Option<unsafe extern "system" fn(pchApplicationManifestFullPath: *const c_char) -> EVRApplicationError>,
    pub IsApplicationInstalled: Option<unsafe extern "system" fn(pchAppKey: *const c_char) -> bool>,
    pub GetApplicationCount: Option<unsafe extern "system" fn() -> u32>,
    pub GetApplicationKeyByIndex: Option<unsafe extern "system" fn(unApplicationIndex: u32, pchAppKeyBuffer: *mut c_char, unAppKeyBufferLen: u32) -> EVRApplicationError>,
    pub GetApplicationKeyByProcessId: Option<unsafe extern "system" fn(unProcessId: u32, pchAppKeyBuffer: *mut c_char, unAppKeyBufferLen: u32) -> EVRApplicationError>,
    pub LaunchApplication: Option<unsafe extern "system" fn(pchAppKey: *const c_char) -> EVRApplicationError>,
    pub LaunchTemplateApplication: Option<unsafe extern "system" fn(pchTemplateAppKey: *const c_char, pchNewAppKey: *const c_char, pKeys: *const c_void, unKeys: u32) -> EVRApplicationError>,
    pub LaunchApplicationFromMimeType: Option<unsafe extern "system" fn(pchMimeType: *const c_char, pchArgs: *const c_char) -> EVRApplicationError>,
    pub LaunchDashboardOverlay: Option<unsafe extern "system" fn(pchAppKey: *const c_char) -> EVRApplicationError>,
    pub CancelApplicationLaunch: Option<unsafe extern "system" fn(pchAppKey: *const c_char) -> bool>,
    pub IdentifyApplication: Option<unsafe extern "system" fn(unProcessId: u32, pchAppKey: *const c_char) -> EVRApplicationError>,
    pub GetApplicationProcessId: Option<unsafe extern "system" fn(pchAppKey: *const c_char) -> u32>,
    pub GetApplicationsErrorNameFromEnum: Option<unsafe extern "system" fn(error: EVRApplicationError) -> *mut c_char>,
    pub GetApplicationPropertyString: Option<unsafe extern "system" fn(pchAppKey: *const c_char, eProperty: EVRApplicationProperty, pchPropertyValueBuffer: *mut c_char, unPropertyValueBufferLen: u32, peError: *mut EVRApplicationError) -> u32>,
    pub GetApplicationPropertyBool: Option<unsafe extern "system" fn(pchAppKey: *const c_char, eProperty: EVRApplicationProperty, peError: *mut EVRApplicationError) -> bool>,
    pub GetApplicationPropertyUint64: Option<unsafe extern "system" fn(pchAppKey: *const c_char, eProperty: EVRApplicationProperty, peError: *mut EVRApplicationError) -> u64>,
    pub SetApplicationAutoLaunch: Option<unsafe extern "system" fn(pchAppKey: *const c_char, bAutoLaunch: bool) -> EVRApplicationError>,
    pub GetApplicationAutoLaunch: Option<unsafe extern "system" fn(pchAppKey: *const c_char) -> bool>,
    pub SetDefaultApplicationForMimeType: Option<unsafe extern "system" fn(pchAppKey: *const c_char, pchMimeType: *const c_char) -> EVRApplicationError>,
    pub GetDefaultApplicationForMimeType: Option<unsafe extern "system" fn(pchMimeType: *const c_char, pchAppKeyBuffer: *mut c_char, unAppKeyBufferLen: u32) -> bool>,
    pub GetApplicationSupportedMimeTypes: Option<unsafe extern "system" fn(pchAppKey: *const c_char, pchMimeTypesBuffer: *mut c_char, unMimeTypesBuffer: u32) -> bool>,
    pub GetApplicationsThatSupportMimeType: Option<unsafe extern "system" fn(pchMimeType: *const c_char, pchAppKeysThatSupportBuffer: *mut c_char, unAppKeysThatSupportBuffer: u32) -> u32>,
    pub GetApplicationLaunchArguments: Option<unsafe extern "system" fn(unHandle: u32, pchArgs: *mut c_char, unArgs: u32) -> u32>,
    pub GetStartingApplication: Option<unsafe extern "system" fn(pchAppKeyBuffer: *mut c_char, unAppKeyBufferLen: u32) -> EVRApplicationError>,
    pub GetSceneApplicationState: Option<unsafe extern "system" fn() -> EVRSceneApplicationState>,
    pub PerformApplicationPrelaunchCheck: Option<unsafe extern "system" fn(pchAppKey: *const c_char) -> EVRApplicationError>,
    pub GetSceneApplicationStateNameFromEnum: Option<unsafe extern "system" fn(state: EVRSceneApplicationState) -> *mut c_char>,
    pub LaunchInternalProcess: Option<unsafe extern "system" fn(pchBinaryPath: *const c_char, pchArguments: *const c_char, pchWorkingDirectory: *const c_char) -> EVRApplicationError>,
    pub RegisterSubprocess: Option<unsafe extern "system" fn(nPid: u32) -> EVRApplicationError>,
    pub GetCurrentSceneProcessId: Option<unsafe extern "system" fn() -> u32>,
}
const _: () = assert!(std::mem::size_of::<VR_IVRApplications_FnTable>() == 31 * 8);

pub const IVRRenderModels_Version: &str = "IVRRenderModels_006";
pub const IVRRenderModels_FnTable: &[u8] = b"FnTable:IVRRenderModels_006\0";

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRRenderModelError(pub i32);
impl EVRRenderModelError {
    pub const VRRenderModelError_None: Self = Self(0);
    pub const VRRenderModelError_Loading: Self = Self(100);
}

#[repr(transparent)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct EVRRenderModelTextureFormat(pub i32);
impl EVRRenderModelTextureFormat {
    pub const VRRenderModelTextureFormat_RGBA8_SRGB: Self = Self(0);
}

pub type VRComponentProperties = u32;
pub const VRComponentProperty_IsStatic: u32 = 1 << 0;
pub const VRComponentProperty_IsVisible: u32 = 1 << 1;

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct RenderModel_ComponentState_t {
    pub mTrackingToComponentRenderModel: HmdMatrix34_t,
    pub mTrackingToComponentLocal: HmdMatrix34_t,
    pub uProperties: VRComponentProperties,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct RenderModel_Vertex_t {
    pub vPosition: HmdVector3_t,
    pub vNormal: HmdVector3_t,
    pub rfTextureCoord: [f32; 2],
}

#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct RenderModel_TextureMap_t {
    pub unWidth: u16,
    pub unHeight: u16,
    pub rubTextureMapData: *const u8,
    pub format: EVRRenderModelTextureFormat,
    pub unMipLevels: u16,
}

#[repr(C)]
#[derive(Copy, Clone, Debug)]
pub struct RenderModel_t {
    pub rVertexData: *const RenderModel_Vertex_t,
    pub unVertexCount: u32,
    pub rIndexData: *const u16,
    pub unTriangleCount: u32,
    pub diffuseTextureId: TextureID_t,
}

#[repr(C)]
#[derive(Copy, Clone, Debug, Default)]
pub struct RenderModel_ControllerMode_State_t {
    pub bScrollWheelVisible: bool,
}

const _: () = assert!(std::mem::size_of::<RenderModel_ComponentState_t>() == 100);
const _: () = assert!(std::mem::size_of::<RenderModel_Vertex_t>() == 32);
const _: () = assert!(std::mem::size_of::<RenderModel_TextureMap_t>() == 24);
const _: () = assert!(std::mem::offset_of!(RenderModel_TextureMap_t, rubTextureMapData) == 8);
const _: () = assert!(std::mem::offset_of!(RenderModel_TextureMap_t, format) == 16);
const _: () = assert!(std::mem::size_of::<RenderModel_t>() == 32);
const _: () = assert!(std::mem::offset_of!(RenderModel_t, rIndexData) == 16);
const _: () = assert!(std::mem::offset_of!(RenderModel_t, diffuseTextureId) == 28);
const _: () = assert!(std::mem::size_of::<RenderModel_ControllerMode_State_t>() == 1);

#[repr(C)]
pub struct VR_IVRRenderModels_FnTable {
    pub LoadRenderModel_Async: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, ppRenderModel: *mut *mut RenderModel_t) -> EVRRenderModelError>,
    pub FreeRenderModel: Option<unsafe extern "system" fn(pRenderModel: *mut RenderModel_t)>,
    pub LoadTexture_Async: Option<unsafe extern "system" fn(textureId: TextureID_t, ppTexture: *mut *mut RenderModel_TextureMap_t) -> EVRRenderModelError>,
    pub FreeTexture: Option<unsafe extern "system" fn(pTexture: *mut RenderModel_TextureMap_t)>,
    pub LoadTextureD3D11_Async: Option<unsafe extern "system" fn(textureId: TextureID_t, pD3D11Device: *mut c_void, ppD3D11Texture2D: *mut *mut c_void) -> EVRRenderModelError>,
    pub LoadIntoTextureD3D11_Async: Option<unsafe extern "system" fn(textureId: TextureID_t, pDstTexture: *mut c_void) -> EVRRenderModelError>,
    pub FreeTextureD3D11: Option<unsafe extern "system" fn(pD3D11Texture2D: *mut c_void)>,
    pub GetRenderModelName: Option<unsafe extern "system" fn(unRenderModelIndex: u32, pchRenderModelName: *mut c_char, unRenderModelNameLen: u32) -> u32>,
    pub GetRenderModelCount: Option<unsafe extern "system" fn() -> u32>,
    pub GetComponentCount: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char) -> u32>,
    pub GetComponentName: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, unComponentIndex: u32, pchComponentName: *mut c_char, unComponentNameLen: u32) -> u32>,
    pub GetComponentButtonMask: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, pchComponentName: *const c_char) -> u64>,
    pub GetComponentRenderModelName: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, pchComponentName: *const c_char, pchComponentRenderModelName: *mut c_char, unComponentRenderModelNameLen: u32) -> u32>,
    pub GetComponentStateForDevicePath: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, pchComponentName: *const c_char, devicePath: VRInputValueHandle_t, pState: *const RenderModel_ControllerMode_State_t, pComponentState: *mut RenderModel_ComponentState_t) -> bool>,
    pub GetComponentState: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, pchComponentName: *const c_char, pControllerState: *const c_void, pState: *const RenderModel_ControllerMode_State_t, pComponentState: *mut RenderModel_ComponentState_t) -> bool>,
    pub RenderModelHasComponent: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, pchComponentName: *const c_char) -> bool>,
    pub GetRenderModelThumbnailURL: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, pchThumbnailURL: *mut c_char, unThumbnailURLLen: u32, peError: *mut EVRRenderModelError) -> u32>,
    pub GetRenderModelOriginalPath: Option<unsafe extern "system" fn(pchRenderModelName: *const c_char, pchOriginalPath: *mut c_char, unOriginalPathLen: u32, peError: *mut EVRRenderModelError) -> u32>,
    pub GetRenderModelErrorNameFromEnum: Option<unsafe extern "system" fn(error: EVRRenderModelError) -> *mut c_char>,
}
const _: () = assert!(std::mem::size_of::<VR_IVRRenderModels_FnTable>() == 19 * 8);

pub type PFN_VR_InitInternal2 = unsafe extern "C" fn(peError: *mut EVRInitError, eApplicationType: EVRApplicationType, pStartupInfo: *const c_char) -> u32;
pub type PFN_VR_ShutdownInternal = unsafe extern "C" fn();
pub type PFN_VR_IsHmdPresent = unsafe extern "C" fn() -> bool;
pub type PFN_VR_IsRuntimeInstalled = unsafe extern "C" fn() -> bool;
pub type PFN_VR_GetRuntimePath = unsafe extern "C" fn(pchPathBuffer: *mut c_char, unBufferSize: u32, punRequiredBufferSize: *mut u32) -> bool;
pub type PFN_VR_GetGenericInterface = unsafe extern "C" fn(pchInterfaceVersion: *const c_char, peError: *mut EVRInitError) -> *mut c_void;
pub type PFN_VR_IsInterfaceVersionValid = unsafe extern "C" fn(pchInterfaceVersion: *const c_char) -> bool;
pub type PFN_VR_GetInitToken = unsafe extern "C" fn() -> u32;
pub type PFN_VR_GetVRInitErrorAsSymbol = unsafe extern "C" fn(error: EVRInitError) -> *const c_char;
pub type PFN_VR_GetVRInitErrorAsEnglishDescription = unsafe extern "C" fn(error: EVRInitError) -> *const c_char;
